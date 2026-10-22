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
  offscreenLink,
  resolveOrphan,
  resumeChat,
  startChat,
  startOffscreenHost,
} from '@duoling/offscreen-document'
import { createConversation, renameConversation } from '@duoling/shared'

export const OFFSCREEN_KIND_PREFIXES = ['conv:', 'chat:'] as const

/** 前缀 → 处理器（与 OFFSCREEN_KIND_PREFIXES 一一对应） */
const PREFIX_HANDLERS: {
  [K in (typeof OFFSCREEN_KIND_PREFIXES)[number]]: (msg: RuntimeRequest) => Promise<unknown>
} = {
  'conv:': (msg) => handleConvCommand(msg),
  'chat:': (msg) => handleChatCommand(msg),
}

startOffscreenHost()

offscreenLink()?.serve('chat:abort', (payload) =>
  handleChatCommand({
    kind: 'chat:abort',
    conversationId: (payload as { conversationId: string }).conversationId,
  }),
)

serveIpc({
  matchers: [prefixMatcher(OFFSCREEN_KIND_PREFIXES, PREFIX_HANDLERS)],
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
