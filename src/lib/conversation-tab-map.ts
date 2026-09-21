// 标签页 → 会话 的归属映射：每个 tab 一条会话，切 tab 即切会话。
//
// 存哪、为什么：落在**应用配置库 `duoling-app`** 的一个键（`convByTab`），而不是给
// `Conversation` 加字段。判据是这条事实的性质 —— 「哪个 tab 现在开着哪条会话」是本机的
// **界面状态**（与 side panel 展开态同类），不是会话的业务属性：tabId 易失（关掉即失去
// 意义）、且会被浏览器复用，把它写进会话记录会让会话带上一份迟早要清理的外键。
// 这样放之后，「会话唯一写方 = offscreen」这条不变量完全不受影响：本模块只读写
// duoling-app 的 kv（扩展页 / SW 都可直连），不碰 duoling-chat。
//
// 键为什么只用 tabId：Chrome 的 tab id 在**整个浏览器 session 内全局唯一**（不是 per-window），
// 所以不需要 windowId 参与。窗口维度只在「面板认定自己属于哪个窗口」时才需要。
//
// 并发写用 `app-db.update` 的原子读-改-写：本表是**整表一个键**，而写方有两处
// （面板新建会话时登记 / SW 在 tab 关闭时移除），可能交错；拆成 get+set 会丢更新。
//
// 读侧容错：会话被删（或整库清空）后映射里会留陈旧项——`getConversationIdForTab` 只负责
// 把它读出来，**由调用方拿会话列表校验**（在列表里找不到就当未绑定）；写侧的删除路径也
// 会顺手清理（见 unbindConversation / unbindAll）。

import * as appDb from './app-db'

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
  if (typeof chrome === 'undefined' || !chrome.tabs?.get) return null
  try {
    await chrome.tabs.get(tabId)
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
