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
//     需要它们时必须经消息请 SW 代办（见包内 chat/sw-bridge.ts）
//   · IndexedDB 同源共享，可直连（会话历史与任务快照都在 duoling-chat 库，走这条，无需经 background 中转）
//   · console 输出落在 **SW 的 inspector**（chrome://extensions → Service Worker），不在面板 DevTools
//   · 不能聚焦；opener 恒为 null；URL 必须是打包进扩展的静态 HTML（即本文件对应的 offscreen.html）
//
// 模块归属（硬约束）：本入口只做接线 —— 启动装配、服务实体、对话编排、会话删除的资源回收、
// 文件库、注册态库写侧与剪贴板写入全在 @duoling/offscreen-document；本文件只引它、
// @duoling/shared 与总线。
// 一旦 import store.ts / fs-store.ts / model-store.ts 这类 SW 专属模块，就会在运行时报
// chrome.storage is undefined —— 这条规则的价值正是把「能不能在这里跑」变成编译器可查的问题。
//
// 生命周期：每扩展同时只能有一份；不主动关就一直活着，但**关窗口 / 扩展重载 / 浏览器崩溃
// 三者它一个都挡不住**，故「任务可恢复」的简化兜底不能省（→ 包内 chat/task-store.ts）。
//
// 命令面：fs:ping（就绪探测，留总线）/ conv:*（会话写侧，唯一写方）/ chat:*（对话编排）；
// fs 组读写、资源库、**注册态库写侧**（userscript*）与剪贴板写入都走 OffscreenService 代理
// （报文无 kind，不占总线）。

import '@/polyfills'
import type { RuntimeRequest } from '@/shared/extension-ipc'
// 标准化总线：本语境唯一的 onMessage 收口（serveIpc）+ 前缀路由 matcher
import { serveIpc, prefixMatcher } from '@/shared/ipc-bus'
// 对话编排、会话删除的资源回收、启动装配都出自包；入口只接线
import {
  abortChat,
  clearAllConversationsWithAssets,
  deleteConversationWithAssets,
  listOrphans,
  onConfigChanged,
  resolveOrphan,
  resumeChat,
  startChat,
  startOffscreenHost,
} from '@duoling/offscreen-document'
import { createConversation, renameConversation } from '@/lib/conversation-store'

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

// 服务实体、保活、就绪握手、首拉配置与启动对账都在包内，入口只负责起它。
startOffscreenHost()

// 命令面：UI / SW 经共享总线发来，offscreen 在此处理并回传。
// 本语境**唯一**的 onMessage 监听器（标准化信道）：问询顺序 = 宿主前缀表（fs: / conv: / chat:）。
// 功能代码只写 handler 与 matcher，不再各自 addListener；服务代理（fs 组 / 注册态写侧 /
// 剪贴板）走库自带 listener，报文形状与命令面互斥、不占问询位。
serveIpc({
  matchers: [prefixMatcher(OFFSCREEN_KIND_PREFIXES, FS_HANDLERS)],
  observe: (msg) => {
    // 写侧推来配置变更（offscreen 不 import SW 专属的 model-store），旁听到就回拉
    if (msg.kind === 'offscreen:configChanged') onConfigChanged()
  },
})

/** conv:* —— 会话写侧（唯一写方 = offscreen；UI 只经这些命令触发写） */
async function handleConvCommand(msg: RuntimeRequest): Promise<unknown> {
  switch (msg.kind) {
    case 'conv:create':
      return createConversation()
    case 'conv:rename':
      return renameConversation(msg.id, msg.title)
    // 删会话连带回收图片：先取候选、删完再算引用面，时序在包内
    case 'conv:delete':
      return deleteConversationWithAssets(msg.id)
    // 清空全部会话 = 引用面必然为空，整库删
    case 'conv:deleteAll':
      return clearAllConversationsWithAssets()
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
