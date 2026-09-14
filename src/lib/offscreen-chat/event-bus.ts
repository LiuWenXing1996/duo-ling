// 对话事件缓冲（方案 §4.8 机制 3，reconnectToStream 真实现的核心）。
//
// offscreen 为每个会话的进行中任务维护一份 UIMessageChunk 环形缓冲：
//   · 每条事件带自增 seq（eventId）；
//   · 侧边栏（观察者）按 seq 去重消费；面板重开 / 切回会话时按 lastEventId replay；
//   · 任务结束后缓冲保留到同会话下一次 chat:start（重开面板还能拿到收尾状态）；
//   · offscreen 被杀则缓冲随之消失——那份兜底是 IndexedDB 任务快照 + 会话历史，不是这里。
//
// 推送通道：chrome.runtime.sendMessage（offscreen → 侧边栏 + SW）。SW 不消费 chat: 前缀
// （不在其路由白名单）；面板未开时 sendMessage 报「无人接收」，尽力而为、不阻断任务。

import type { UIMessageChunk } from 'ai'
import type { OffscreenPush } from '@/shared/extension-ipc'

/** 单会话缓冲上限（条）。UIMessageChunk 都很小，4000 条足够覆盖 maxSteps=8 的长任务 */
const MAX_EVENTS_PER_CHAT = 4000

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

/** 当前最新 seq（侧边栏首次 resume 前查询用） */
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
    // 环形：丢最老的。重连方 lastEventId 落在被丢弃区间时按「缓冲已不完整」处理（返回 idle）
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
