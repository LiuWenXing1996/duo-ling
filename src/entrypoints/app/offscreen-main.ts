// offscreen document 入口 —— AI 生成链路的执行宿主。
// 为什么必须这个容器（三种宿主的寿命对照）、能力边界（只有 chrome.runtime）、
// 模块归属硬约束（本入口只做接线，实体全在 @duoling/offscreen-document）、
// 生命周期与命令面，见 ARCHITECTURE.md「对话链路」节的 offscreen 容器小节。

import '@/polyfills'
import type { RuntimeRequest } from '@duoling/shared'
// 标准化总线：本语境唯一的 onMessage 收口（serveIpc）+ 前缀路由 matcher
import { prefixMatcher, serveIpc } from '@/shared/ipc-bus'
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
import { createConversation, renameConversation } from '@duoling/shared'

/**
 * offscreen 应答的命令面前缀（与 SW 的 SW_KIND_PREFIXES 互补，两者并集须恰好覆盖
 * RuntimeRequest 的 kind 全集——归属一致性由 extension-ipc.test.ts 表驱动断言）。
 * 剪贴板写入既不进本表也不进命令面：它收在 OffscreenService（服务代理报文，无 kind）。
 */
export const OFFSCREEN_KIND_PREFIXES = ['fs:', 'conv:', 'chat:'] as const

/** 前缀 → 处理器（与 OFFSCREEN_KIND_PREFIXES 一一对应） */
const FS_HANDLERS: {
  [K in (typeof OFFSCREEN_KIND_PREFIXES)[number]]: (msg: RuntimeRequest) => Promise<unknown>
} = {
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
      // 显式挑四个字段：包只认 ChatStartInput，命令面的 kind 等细节不进包
      return startChat({
        conversationId: msg.conversationId,
        messages: msg.messages,
        trigger: msg.trigger,
        pageContext: msg.pageContext,
      })
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
