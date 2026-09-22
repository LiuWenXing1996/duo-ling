// 通知中心：需要用户回来看一眼的事。角标报数（未读 + 进行中），popup 给明细。
//
// 为什么落 `duoling-app` 的 kv：与「标签页 → 会话」映射同类 —— 扩展自己的界面状态，量小、
// 写频低，不值得单开库。写方有两处（SW 记通知、popup 标已读），故一律走 `appDb.update` 原子读改写，
// 拆成 get + set 会互相覆盖。
//
// **只存「已发生的事」**：正在生成的任务不在这里 —— 它没有稳定落点（SW 被回收后无从对账），
// 由 SW 的内存集合表达，popup 问的时候一并带上。角标数字 = 进行中数 + 这里的未读数。
//
// 同一会话的未读只留一条（跑两次都还没看 = 一件事，留最新那条），否则角标数字会虚高；
// 已读按条留、最多 20 条 —— 它不是历史记录，只是「刚才那几条」。

import * as appDb from './app-db'
import type { AppNotification } from '@/shared/extension-ipc'

const KEY = 'notifications'

/** 未读条数上限：防病态增长（正常用户远到不了），超了丢最老 */
const MAX_UNREAD = 50
/** 已读保留条数：仅为「刚看过的那几条」留个回头路 */
const MAX_READ = 20

/** 把库里的原始值收窄成合法列表（非对象 / 缺关键字段的一律丢弃，防手改或旧数据带脏） */
function normalize(raw: unknown): AppNotification[] {
  if (!Array.isArray(raw)) return []
  const out: AppNotification[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const n = item as Record<string, unknown>
    if (typeof n.id !== 'string' || !n.id) continue
    if (n.kind !== 'chat-done') continue
    if (typeof n.conversationId !== 'string' || !n.conversationId) continue
    if (typeof n.createdAt !== 'number') continue
    const rec: AppNotification = {
      id: n.id,
      kind: 'chat-done',
      conversationId: n.conversationId,
      tabId: typeof n.tabId === 'number' ? n.tabId : null,
      host: typeof n.host === 'string' ? n.host : '',
      createdAt: n.createdAt,
    }
    if (typeof n.readAt === 'number') rec.readAt = n.readAt
    out.push(rec)
  }
  return out
}

/** 新的在前（未读 / 已读混排也按时间） */
function byNewest(a: AppNotification, b: AppNotification): number {
  return b.createdAt - a.createdAt
}

/**
 * 收口：按时间排序 + 各自封顶。
 * 未读与已读分别封顶而不是整体封顶 —— 整体封顶会让「攒了很多未读」把「刚看过的」挤掉。
 */
function trimmed(list: AppNotification[]): AppNotification[] {
  const sorted = [...list].sort(byNewest)
  const unread = sorted.filter((n) => n.readAt == null).slice(0, MAX_UNREAD)
  const read = sorted.filter((n) => n.readAt != null).slice(0, MAX_READ)
  return [...unread, ...read].sort(byNewest)
}

/** 全量列表（新的在前） */
export async function listNotifications(): Promise<AppNotification[]> {
  return trimmed(normalize(await appDb.get(KEY)))
}

/** 未读条数（角标要用） */
export async function countUnread(): Promise<number> {
  return (await listNotifications()).filter((n) => n.readAt == null).length
}

/**
 * 记一条「对话跑完了、但用户没看」。
 * 同一会话已有的未读会被替换（不是追加）：那是同一件事的最新状态。
 */
export async function addChatDone(input: {
  conversationId: string
  tabId: number | null
  host: string
}): Promise<AppNotification> {
  const record: AppNotification = {
    id: crypto.randomUUID(),
    kind: 'chat-done',
    conversationId: input.conversationId,
    tabId: input.tabId,
    host: input.host,
    createdAt: Date.now(),
  }
  await appDb.update<unknown>(KEY, (prev) =>
    trimmed([
      record,
      ...normalize(prev).filter((n) => !(n.conversationId === input.conversationId && n.readAt == null)),
    ]),
  )
  return record
}

/** 标一条已读（id 不存在 = no-op） */
export async function markRead(id: string): Promise<void> {
  await appDb.update<unknown>(KEY, (prev) => {
    const now = Date.now()
    return trimmed(normalize(prev).map((n) => (n.id === id && n.readAt == null ? { ...n, readAt: now } : n)))
  })
}

/**
 * 标某条会话的全部未读为已读 —— 用户在该标签页展开了浮层，结果就在眼前。
 * 按会话标而不是「全清」：别的标签页的未读不该被人替他读掉。
 */
export async function markConversationRead(conversationId: string): Promise<number> {
  const now = Date.now()
  let changed = 0
  await appDb.update<unknown>(KEY, (prev) => {
    const next = normalize(prev).map((n) => {
      if (n.conversationId !== conversationId || n.readAt != null) return n
      changed += 1
      return { ...n, readAt: now }
    })
    return trimmed(next)
  })
  return changed
}

/**
 * 清掉指向某条会话的全部通知（会话被删时调）。
 * 留着它们只会指向一个不存在的对话：弹层里点开既没有标签页、也没有会话可回。
 */
export async function removeByConversation(conversationId: string): Promise<number> {
  let removed = 0
  await appDb.update<unknown>(KEY, (prev) =>
    trimmed(
      normalize(prev).filter((n) => {
        if (n.conversationId !== conversationId) return true
        removed += 1
        return false
      }),
    ),
  )
  return removed
}

/** 清空全部通知（「删除全部会话」时调 —— 通知都指向已删的会话，没有留下的理由） */
export async function removeAll(): Promise<number> {
  const removed = (await listNotifications()).length
  await appDb.remove(KEY)
  return removed
}

/** 全部已读（popup 的「全部已读」） */
export async function markAllRead(): Promise<number> {
  const now = Date.now()
  let changed = 0
  await appDb.update<unknown>(KEY, (prev) => {
    const next = normalize(prev).map((n) => {
      if (n.readAt != null) return n
      changed += 1
      return { ...n, readAt: now }
    })
    return trimmed(next)
  })
  return changed
}
