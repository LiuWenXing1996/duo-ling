// offscreen document 入口 —— AI 生成链路的执行宿主。
//
// 为什么需要这个容器（三种宿主的寿命对照）：
//   · 对话界面 / 工作台（document）：用户一关即**立即销毁**（浮层收起时文档同样被销毁），连保存现场的时机都没有
//   · background SW：空闲 30s 即回收，且单次调用有 5 分钟硬顶（不可绕过，官方不鼓励保活）
//   · offscreen document：**不主动关就一直活着**（唯一）
// 而 agent loop 要求宿主「不会在任务中途被回收」——用户关面板即销毁的载体全出局，offscreen 是唯一解。
//
// 能力边界（官方原话：runtime API is the only extensions API supported by offscreen documents）：
//   · 只有 chrome.runtime 可用 —— chrome.storage / chrome.userScripts / chrome.tabs 全拿不到，
//     需要它们时必须经消息请 SW 代办（见 src/lib/offscreen-bridge.ts）
//   · IndexedDB 同源共享，可直连（会话历史与任务快照都在 duoling-chat 库，走这条，无需经 background 中转）
//   · console 输出落在 **SW 的 inspector**（chrome://extensions → Service Worker），不在面板 DevTools
//   · 不能聚焦；opener 恒为 null；URL 必须是打包进扩展的静态 HTML（即本文件对应的 offscreen.html）
//
// 模块归属（硬约束）：本入口只允许 import extension-chat-transport.ts、ai SDK、
// offscreen-bridge.ts、offscreen-chat/（对话编排，内部只引裸 IndexedDB 模块）、
// @duoling/userscript-core / @duoling/offscreen-document（纯函数 + offscreen 环境代码，
// import 期零副作用；文件库 duoling-fs、注册态库写侧与剪贴板写入都在其中，分别经 fs
// 原语与 OffscreenService 暴露）。
// 一旦 import store.ts / fs-store.ts / model-store.ts 这类 SW 专属模块，就会在运行时报
// chrome.storage is undefined —— 这条规则的价值正是把「能不能在这里跑」变成编译器可查的问题。
//
// 生命周期：每扩展同时只能有一份；不主动关就一直活着，但**关窗口 / 扩展重载 / 浏览器崩溃
// 三者它一个都挡不住**，故「任务可恢复」的简化兜底不能省（→ offscreen-chat/task-store.ts）。
//
// 命令面：fs:ping（就绪探测，留总线）/ conv:*（会话写侧，唯一写方）/ chat:*（对话编排）；
// fs 组读写、资源库、**注册态库写侧**（userscript*）与剪贴板写入都走 OffscreenService 代理
// （报文无 kind，不占总线）。

import '@/polyfills'
import type { RuntimeRequest } from '@/shared/extension-ipc'
// 标准化总线：本语境唯一的 onMessage 收口（serveIpc）+ 前缀路由 matcher；
// ipcNotify 为单向推送入口（就绪握手 / 配置回拉触发）
import { serveIpc, prefixMatcher, ipcNotify } from '@/shared/ipc-bus'
// SW 保活轮询 + 本容器的服务实体（含剪贴板写入）+ 启动对账：都出自包，启动 / 注册归宿主
import { OffscreenService, reconcileFs, startSwKeepalive } from '@duoling/offscreen-document'
import { registerOffscreenService } from '@duoling/shared'
import {
  abortChat,
  listOrphans,
  resolveOrphan,
  resumeChat,
  startChat,
} from '@/lib/offscreen-chat/chat-host'
import {
  createConversation,
  deleteAllConversations,
  deleteConversation,
  renameConversation,
} from '@/lib/conversation-store'
import {
  assetIdsOf,
  releaseAllAssets,
  releaseUnreferencedAssets,
} from '@/lib/offscreen-chat/asset-lifecycle'
import { refreshActiveProfile } from '@/lib/offscreen-chat/profile-cache'

/** 就绪握手：告知 SW 容器已起（SW 侧据此确认状态、排查启动问题） */
function announceReady(): void {
  // 经标准总线单向推送（尽力而为：SW 未就绪或未注册该命令时不阻断 offscreen 自身启动）
  ipcNotify({ kind: 'offscreen:ready' })
}

// 模型配置写侧（model-store 写出口）的单向推送：offscreen 不 import model-store（SW 专属模块），
// 配置变更由写侧推 offscreen:configChanged、这里触发回拉。

/**
 * offscreen 应答的命令面前缀（与 SW 的 SW_KIND_PREFIXES 互补，两者并集须恰好覆盖
 * RuntimeRequest 的 kind 全集——归属一致性由 extension-ipc.test.ts 表驱动断言）。
 * 剪贴板写入既不进本表也不进命令面：它收在 OffscreenService（服务代理报文，无 kind）。
 */
export const OFFSCREEN_KIND_PREFIXES = ['fs:', 'conv:', 'chat:'] as const

/** 前缀 → 处理器（与 OFFSCREEN_KIND_PREFIXES 一一对应） */
const FS_HANDLERS: { [K in (typeof OFFSCREEN_KIND_PREFIXES)[number]]: (msg: RuntimeRequest) => Promise<unknown> } = {
  // fs: 只剩就绪探测 —— 其余 fs 命令与注册态库写侧（userscript*）走 OffscreenService 代理
  'fs:': async () => ({ ready: true }),
  'conv:': (msg) => handleConvCommand(msg),
  'chat:': (msg) => handleChatCommand(msg),
}

// 服务实体：顶层同步注册，迟了会漏掉早到的调用（容器重建会重跑本入口，故无需去重）。
registerOffscreenService(new OffscreenService())

// 保活：SW 空闲 30s 即回收，而 GM 链路的在途操作全押在它常驻上 —— 入口顶层启一次即全程在线。
startSwKeepalive()

// 命令面：UI / SW 经共享总线发来，offscreen 在此处理并回传。
// 本语境**唯一**的 onMessage 监听器（标准化信道）：问询顺序 = 宿主前缀表（fs: / conv: / chat:）。
// 功能代码只写 handler 与 matcher，不再各自 addListener；服务代理（fs 组 / 注册态写侧 /
// 剪贴板）走库自带 listener，报文形状与命令面互斥、不占问询位。
serveIpc({
  matchers: [prefixMatcher(OFFSCREEN_KIND_PREFIXES, FS_HANDLERS)],
  observe: (msg) => {
    if (msg.kind === 'offscreen:configChanged') void refreshActiveProfile()
  },
})

/** conv:* —— 会话写侧（唯一写方 = offscreen；UI 只经这些命令触发写） */
async function handleConvCommand(msg: RuntimeRequest): Promise<unknown> {
  switch (msg.kind) {
    case 'conv:create':
      return createConversation()
    case 'conv:rename':
      return renameConversation(msg.id, msg.title)
    // 删会话连带回收图片资源：候选要**在删之前**取（删完就读不到这些消息了），
    // 回收本身放在删之后（那时引用面才是「删完的真相」）。回收失败不影响删会话 ——
    // 用户要的结果已经达成，留下的图最多是垃圾，下次再收（见 asset-lifecycle 文件头）。
    case 'conv:delete': {
      const candidates = await assetIdsOf(msg.id)
      await deleteConversation(msg.id)
      await releaseUnreferencedAssets(candidates).catch(() => {})
      return undefined
    }
    // 清空全部会话 = 引用面必然为空，整库删
    case 'conv:deleteAll': {
      await deleteAllConversations()
      await releaseAllAssets().catch(() => {})
      return undefined
    }
    default:
      throw new Error(`未知会话命令：${(msg as { kind: string }).kind}`)
  }
}

/** chat:* —— 对话编排（发起 / 停止 / 重连 / 孤儿） */
async function handleChatCommand(msg: RuntimeRequest): Promise<unknown> {
  switch (msg.kind) {
    case 'chat:start':
      return startChat(msg)
    case 'chat:abort':
      return abortChat(msg.conversationId)
    case 'chat:resume':
      return resumeChat(msg.conversationId)
    case 'chat:orphans':
      return listOrphans()
    case 'chat:orphanAction':
      return resolveOrphan(msg.taskId, msg.action)
    default:
      throw new Error(`未知对话命令：${msg.kind}`)
  }
}

announceReady()
void refreshActiveProfile()
// 启动一次对账：清掉无主的孤儿仓目录（幂等，失败不阻断）
void reconcileFs()
