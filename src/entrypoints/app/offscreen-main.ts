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
// 模块归属（硬约束）：本入口只允许 import us-git.ts（纯 JS 的 git 栈 + lightning-fs）、
// extension-chat-transport.ts、ai SDK、offscreen-bridge.ts、offscreen-chat/（对话编排，
// 内部只引裸 IndexedDB 模块）、@duoling/userscript-offscreen / @duoling/userscript-core /
// @duoling/offscreen-document（纯函数 + offscreen 环境代码，import 期零副作用），
// 以及 offscreen-only 的 lib/userscripts/offscreen-fs-commands.ts（源码库 duoling-fs 的
// fs:* 命令面）与 offscreen-state-commands.ts（注册态库的写侧）。
// 一旦 import store.ts / fs-store.ts / model-store.ts 这类 SW 专属模块，就会在运行时报
// chrome.storage is undefined —— 这条规则的价值正是把「能不能在这里跑」变成编译器可查的问题。
//
// 生命周期：每扩展同时只能有一份；不主动关就一直活着，但**关窗口 / 扩展重载 / 浏览器崩溃
// 三者它一个都挡不住**，故「任务可恢复」的简化兜底不能省（→ offscreen-chat/task-store.ts）。
//
// 命令面：fs:*（源码库 duoling-fs 的读写 + 对话资源库 /assets）/ state:*（注册态库写侧）/
// conv:*（会话写侧，唯一写方）/ chat:*（对话编排）；clipboard: 归 GM 运行时的 offscreen 包
// （createOffscreenHost 的 handle，由本入口总线代挂监听，见文件中部与尾部的接线）。

import '@/polyfills'
import type { RuntimeRequest } from '@/shared/extension-ipc'
import { IPC_CLIPBOARD_WRITE } from '@duoling/shared'
// 标准化总线：本语境唯一的 onMessage 收口（serveIpc）+ 前缀路由 matcher；
// ipcNotify 为单向推送入口（就绪握手 / 配置回拉触发）
import { serveIpc, prefixMatcher, ipcNotify } from '@/shared/ipc-bus'
import { handleFsCommand, type FsRequest } from '@/lib/userscripts/offscreen-fs-commands'
import { handleStateCommand, reconcileFs, type StateRequest } from '@/lib/userscripts/offscreen-state-commands'
// GM 运行时的 offscreen 命令面（clipboard:write 应答）：包工厂不管生命周期与监听，
// 监听由本入口的总线代挂（`{ listen: false }` + matcher 问询）—— 每语境只有一个监听器。
import { createOffscreenHost } from '@duoling/userscript-offscreen'
// SW 保活轮询：同属 offscreen 侧职责，但启动点归宿主（包只出原语）
import { startSwKeepalive } from '@duoling/offscreen-document'
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
 * clipboard: 例外：不在本表 —— 它归 GM 运行时的 createOffscreenHost() 自管（自有监听器应答）。
 */
export const OFFSCREEN_KIND_PREFIXES = ['fs:', 'state:', 'conv:', 'chat:'] as const

/** 前缀 → 处理器（与 OFFSCREEN_KIND_PREFIXES 一一对应） */
const FS_HANDLERS: { [K in (typeof OFFSCREEN_KIND_PREFIXES)[number]]: (msg: RuntimeRequest) => Promise<unknown> } = {
  'fs:': (msg) => handleFsCommand(msg as FsRequest),
  'state:': (msg) => handleStateCommand(msg as StateRequest),
  'conv:': (msg) => handleConvCommand(msg),
  'chat:': (msg) => handleChatCommand(msg),
}

// GM 运行时的 offscreen 命令面实例：`listen: false` = 不自挂监听（本入口的总线代挂）。
const offscreenHost = createOffscreenHost({ listen: false })

// 保活：SW 空闲 30s 即回收，而 GM 链路的在途操作全押在它常驻上 —— 入口顶层启一次即全程在线。
startSwKeepalive()

// 命令面：UI / SW 经共享总线发来，offscreen 在此处理并回传。
// 本语境**唯一**的 onMessage 监听器（标准化信道）：问询顺序 =
//   ① 宿主前缀表（fs: / state: / conv: / chat:）；
//   ② GM 运行时 offscreen 包自管的命令面（clipboard:write，见文件尾的 createOffscreenHost）。
// 功能代码只写 handler 与 matcher，不再各自 addListener。
serveIpc({
  matchers: [
    prefixMatcher(OFFSCREEN_KIND_PREFIXES, FS_HANDLERS),
    { owns: (kind) => kind === IPC_CLIPBOARD_WRITE, handle: (msg) => offscreenHost.handle(msg) },
  ],
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
// 启动一次最终一致对账：补齐缺失仓、清理多余仓目录（幂等，失败不阻断）
void reconcileFs()
