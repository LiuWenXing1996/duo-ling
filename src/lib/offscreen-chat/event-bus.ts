// 对话事件缓冲（reconnectToStream 真实现的核心）。
//
// offscreen 为每个会话的进行中任务维护一份 UIMessageChunk 环形缓冲：
//   · 每条事件带自增 seq（每轮任务从 1 重计）；
//   · 对话界面（观察者）按 seq 去重；重连（chat:resume）时**从头全量回放**——
//     观察方本地视图可能刚从会话历史重建，按消费点续传会缺 start 类配对块；
//   · **只服务进行中任务的重连**：任务收尾（正常 / 中止 / 异常）即 dropBuffer——
//     收尾后结果已在会话历史，保留缓冲只会让重开面板 replay 出重复消息；
//   · offscreen 被杀则缓冲随之消失——那份兜底是 IndexedDB 任务快照 + 会话历史，不是这里。
//   · ⚠️ 缓冲**不用于落盘还原**：4000 条上限会被长回复（万级 text delta）截断，
//     落盘走 chat-host 泵流时自收的完整 chunk 序列（buildFinalMessageFromChunks）。
//
// 推送通道：chrome.runtime.sendMessage（offscreen → 对话界面 + SW）。SW 不消费 chat: 前缀
// （不在其路由白名单）；面板未开时 sendMessage 报「无人接收」，尽力而为、不阻断任务。

import type { UIMessageChunk } from 'ai'
import type { OffscreenPush } from '@/shared/extension-ipc'

/** 单会话缓冲上限（条）。长回复按 ~1 delta/token 计，2.3 万 token ≈ 2.3 万条——
 * 上限须按最坏 token 量论证（4000 条曾被 23013 token 的回复冲穿）。被截断时
 * resume 按「缓冲不完整」处理（返回 idle，UI 回退到会话历史） */
const MAX_EVENTS_PER_CHAT = 50_000

interface ChatBuffer {
  seq: number
  events: Array<{ seq: number; chunk: UIMessageChunk }>
}

const buffers = new Map<string, ChatBuffer>()

function bufferOf(conversationId: string): ChatBuffer {
  let b = buffers.get(conversationId)
  if (!b) {
    b = { seq: 0, events: [] }
    buffers.set(conversationId, b)
  }
  return b
}

/** 清空某会话的旧缓冲（同会话新一轮任务开始时调用，避免 replay 出上一轮的事件） */
export function resetBuffer(conversationId: string): void {
  buffers.delete(conversationId)
}

/** 丢弃某会话的缓冲（任务收尾且无需保留时） */
export function dropBuffer(conversationId: string): void {
  buffers.delete(conversationId)
}

/** 当前最新 seq（对话界面首次 resume 前查询用） */
export function latestSeq(conversationId: string): number {
  return buffers.get(conversationId)?.seq ?? 0
}

/** 追加一条事件：入缓冲、按 seq 推给观察者。返回该事件的 seq */
export function pushChunk(conversationId: string, chunk: UIMessageChunk): number {
  const b = bufferOf(conversationId)
  b.seq += 1
  const event = { seq: b.seq, chunk }
  b.events.push(event)
  if (b.events.length > MAX_EVENTS_PER_CHAT) {
    // 环形：丢最老的。缓冲被截断时 resume（从头回放）判「不完整」返回 idle
    b.events.splice(0, b.events.length - MAX_EVENTS_PER_CHAT)
  }
  const push: OffscreenPush = { kind: 'chat:chunk', conversationId, seq: event.seq, chunk }
  // 尽力而为：面板未开 / SW 未起都会 reject，任务照跑
  void chrome.runtime.sendMessage(push).catch(() => {})
  return event.seq
}

/** 取 seq > since 的事件（升序）；false 表示 since 早于缓冲最早保留点（缓冲不完整） */
export function replaySince(
  conversationId: string,
  since: number,
): { complete: boolean; events: Array<{ seq: number; chunk: UIMessageChunk }> } {
  const b = buffers.get(conversationId)
  if (!b) return { complete: true, events: [] }
  const oldest = b.events[0]?.seq ?? b.seq + 1
  if (since < oldest - 1) return { complete: false, events: [] }
  return { complete: true, events: b.events.filter((e) => e.seq > since) }
}

/**
 * 任务开始推送（chat:running）：SW 旁听后点亮「进行中」角标，并把状态写给该会话所属标签页的
 * 悬浮按钮。每个任务推一次（细节进度在 chat:chunk 里，SW 不必逐条消费）。
 * 尽力而为：SW 未起 / 无接收方都会 reject，任务照跑。
 */
export function notifyChatRunning(conversationId: string): void {
  const push: OffscreenPush = { kind: 'chat:running', conversationId }
  void chrome.runtime.sendMessage(push).catch(() => {})
}

/**
 * 任务收尾推送（chat:finished）：SW 旁听后在「浮层没展开」时点亮完成角标。
 * ok = 是否正常收敛（停止 / 异常为 false；徽章同亮同色，不区分）。
 * 尽力而为：SW 未起 / 无接收方都会 reject，任务收尾不受影响。
 */
export function notifyChatFinished(conversationId: string, ok: boolean): void {
  const push: OffscreenPush = { kind: 'chat:finished', conversationId, ok }
  void chrome.runtime.sendMessage(push).catch(() => {})
}
