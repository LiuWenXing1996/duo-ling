// 标签页 → 会话 的归属映射：每个 tab 一条会话，切 tab 即切会话。
// 存放位置（duoling-app 的 kv）与并发 / 容错口径
// 见 docs/adr/0014-tab-conversation-map-in-app-db.md。

import * as appDb from './app-db'
import { tabsGet } from './host'

/** duoling-app 的键名（整表一个键：`{ [tabId]: conversationId }`） */
const KEY = 'convByTab'

/** tabId（字符串化）→ conversationId */
export type TabConversationMap = Record<string, string>

/** 把库里的原始值收窄成合法映射（非对象 / 非字符串值一律丢弃，防手改或旧数据带脏） */
function normalize(raw: unknown): TabConversationMap {
  if (!raw || typeof raw !== 'object') return {}
  const out: TabConversationMap = {}
  for (const [tabId, conversationId] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof conversationId === 'string' && conversationId) out[tabId] = conversationId
  }
  return out
}

/** 整表读出（供需要一次拿全量的调用方，如「会话被删时清掉它的全部绑定」） */
export async function getTabConversationMap(): Promise<TabConversationMap> {
  return normalize(await appDb.get(KEY))
}

/** 某 tab 的归属会话 id；无绑定返回 null（= 未绑定态，会话尚未创建） */
export async function getConversationIdForTab(tabId: number): Promise<string | null> {
  const map = await getTabConversationMap()
  return map[String(tabId)] ?? null
}

/** 登记：把 tab 绑到会话（首次在该 tab 发消息、会话刚创建时调用） */
export async function bindTabToConversation(tabId: number, conversationId: string): Promise<void> {
  await appDb.update<TabConversationMap>(KEY, (prev) => ({
    ...normalize(prev),
    [String(tabId)]: conversationId,
  }))
}

/** 解绑单个 tab（tab 关闭时由 SW 调用；会话本体保留在会话库里） */
export async function unbindTab(tabId: number): Promise<void> {
  await appDb.update<TabConversationMap>(KEY, (prev) => {
    const next = { ...normalize(prev) }
    delete next[String(tabId)]
    return next
  })
}

/** 解绑指向某会话的全部 tab（会话被删除时调用，避免留下指向已删会话的陈旧项） */
export async function unbindConversation(conversationId: string): Promise<void> {
  await appDb.update<TabConversationMap>(KEY, (prev) => {
    const next: TabConversationMap = {}
    for (const [tabId, id] of Object.entries(normalize(prev))) {
      if (id !== conversationId) next[tabId] = id
    }
    return next
  })
}

/** 清空整表（清空全部会话时调用） */
export async function unbindAll(): Promise<void> {
  await appDb.update<TabConversationMap>(KEY, () => ({}))
}

// —— 「这条会话是不是正被标签页用着」 ——
//
// 删除会话前的判据：只要还有**开着的**标签页归属它，就不让删（会话是那个标签页的现场，
// 删掉它等于把用户正在看的东西抽走）。判据不是「映射里有这条」——映射项由 SW 在
// `tabs.onRemoved` 清理，而 SW 可能被回收、清理也可能没跑成，留下指向**已关闭**标签页的
// 残留项；只看映射就会把已关的标签页算成「正在使用」，用户既删不掉、又找不到是哪个标签页，
// 成了死结。所以必须再验一次 tab 是否还在。

/** tab 存活判定：true 还在 / false 已不在 / null 无法判定（当前上下文没有 chrome.tabs） */
async function tabAliveState(tabId: number): Promise<boolean | null> {
  const probe = tabsGet(tabId)
  if (!probe) return null
  try {
    await probe
    return true
  } catch {
    return false
  }
}

/**
 * 有效的归属关系：只保留**标签页还开着**的那些条目，顺手指掉残留项。
 *
 * 拿不到 `chrome.tabs`（单测 / 非扩展页上下文）时**保守视为仍然有效** ——
 * 宁可少让删一条，也不误删一个可能正在对话的标签页的会话。
 */
export async function getActiveTabBindings(): Promise<TabConversationMap> {
  const map = await getTabConversationMap()
  const alive: TabConversationMap = {}
  const stale: string[] = []
  for (const [tabId, conversationId] of Object.entries(map)) {
    if ((await tabAliveState(Number(tabId))) === false) stale.push(tabId)
    else alive[tabId] = conversationId
  }
  if (stale.length) {
    // 只删这几个键：mutate 里重新读当前值，因此期间别人新建的绑定不会被这次写回抹掉
    await appDb
      .update<TabConversationMap>(KEY, (prev) => {
        const next = { ...normalize(prev) }
        for (const tabId of stale) delete next[tabId]
        return next
      })
      .catch(() => {})
  }
  return alive
}

/** 哪些**还开着的**标签页正在使用这条会话；空数组 = 没人用，可以删 */
export async function findTabsUsingConversation(conversationId: string): Promise<number[]> {
  const bindings = await getActiveTabBindings()
  return Object.entries(bindings)
    .filter(([, id]) => id === conversationId)
    .map(([tabId]) => Number(tabId))
}
