// 网络录制 · per-tab 门禁（隐私边界的第一层）。
//
// 录制是**默认关、按标签页显式开**：这里维护「正在录制的会话」——每个会话锚在一个标签页上，
// 存扩展自有 kv（duoling-app）——它有固定键、写频极低，与 netlog 的观测数据分属两类。
//
// 注册侧消费：engine.syncNetRecorder 读本模块的 host 集合 → 只对这些 host 注册捕获件/转发件
// （见 engine.ts）。注意 host 只是**注册粒度**（声明式注册没有 tab 维度，Chrome 的
// RegisteredUserScript 匹配字段全是 URL），门禁真正生效在入站处：dl-bridge 按 sender.tab.id
// 认领会话，不在会话里的标签页送来的数据一律丢弃。所以「某个 host 上装着录制件」不等于
// 「该 host 的所有标签页都在录」。
//
// 会话随标签页消亡：标签页关闭即结束会话（background 的 tabs.onRemoved），同站点的其他标签页
// 要录得各自开一次。结束只摘门禁，不动已录记录 —— 记录留在 netlog 里，会话元信息归档后
// 供查询界面辨认。
//
// 与 cookie-gate.ts 的分工：cookie 门在 SW 请求链路逐次校验（url 维度）；
// 这里在注册链路给 host 装上注入、在入站链路按 tab 裁（两者都只比 scheme/host，path 不参与）。

import * as appDb from '@/lib/app-db'
import { normalizeHost, type NetRecordSession } from './net-record-protocol'

/** kv 键：正在进行录制的会话列表（NetRecordSession[]） */
const NET_CAPTURE_SESSIONS_KEY = 'netCaptureSessions'

/** 收窄一条存储里的会话；缺 id / host / tabId 这些判据字段即丢弃 */
function normalizeSession(raw: unknown): NetRecordSession | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const id = typeof s.id === 'string' ? s.id : ''
  const host = normalizeHost(String(s.host ?? ''))
  const tabId = typeof s.tabId === 'number' && Number.isInteger(s.tabId) && s.tabId > 0 ? s.tabId : 0
  if (!id || !host || !tabId) return null
  const out: NetRecordSession = {
    id,
    tabId,
    host,
    url: typeof s.url === 'string' ? s.url : '',
    title: typeof s.title === 'string' ? s.title : '',
    startedAt:
      typeof s.startedAt === 'number' && Number.isFinite(s.startedAt) ? Math.trunc(s.startedAt) : Date.now(),
  }
  if (typeof s.endedAt === 'number' && Number.isFinite(s.endedAt)) out.endedAt = Math.trunc(s.endedAt)
  return out
}

/**
 * 正在录制的会话（存储缺失 / 脏数据一律收敛为可用子集）。
 * 同 id 去重：id 是记录归属键，重复进集合会让「同一条记录属于两个会话」这种判断变得可能。
 */
export async function getNetCaptureSessions(): Promise<NetRecordSession[]> {
  let stored: unknown
  try {
    stored = await appDb.get<unknown>(NET_CAPTURE_SESSIONS_KEY)
  } catch {
    return []
  }
  if (!Array.isArray(stored)) return []
  const out: NetRecordSession[] = []
  for (const item of stored) {
    const s = normalizeSession(item)
    if (s && !out.some((x) => x.id === s.id)) out.push(s)
  }
  return out
}

/** 整体覆写会话列表（内部入口；外部走 start / stop），返回归一后的结果 */
async function setNetCaptureSessions(list: NetRecordSession[]): Promise<NetRecordSession[]> {
  const next: NetRecordSession[] = []
  for (const item of list) {
    const s = normalizeSession(item)
    if (s && !next.some((x) => x.id === s.id)) next.push(s)
  }
  await appDb.set(NET_CAPTURE_SESSIONS_KEY, next)
  return next
}

/** 正在录制的站点（去重）——注册链路用：只有这些 host 值得装上录制件 */
export async function getRecordingHosts(): Promise<string[]> {
  const out: string[] = []
  for (const s of await getNetCaptureSessions()) {
    if (!out.includes(s.host)) out.push(s.host)
  }
  return out
}

/**
 * 在某个标签页上开始录制。
 *
 * 同标签页 + 同站点已开着时**幂等**返回原有会话（用户重复点「开启」不该换掉正在录的那个）。
 * 同标签页换了站点则结束旧会话并把它交给调用方归档：一个标签页同时只录一个站点，
 * 旧会话继续留着既无处可录，也会让注册集合虚扩到没人在录的站点。
 */
export async function startNetSession(input: {
  tabId: number
  host: string
  url?: string
  title?: string
}): Promise<{ session: NetRecordSession; sessions: NetRecordSession[]; replaced: NetRecordSession[] }> {
  const host = normalizeHost(input.host)
  if (!host) throw new Error(`无效的站点：${input.host}`)
  if (!Number.isInteger(input.tabId) || input.tabId <= 0) {
    throw new Error('无法确定录制所在的标签页，请在目标页面上重试')
  }
  const cur = await getNetCaptureSessions()
  const sameTab = cur.filter((s) => s.tabId === input.tabId)
  const hit = sameTab.find((s) => s.host === host)
  if (hit) return { session: hit, sessions: cur, replaced: [] }
  const now = Date.now()
  const session: NetRecordSession = {
    id: crypto.randomUUID(),
    tabId: input.tabId,
    host,
    url: input.url ?? '',
    title: input.title ?? '',
    startedAt: now,
  }
  const rest = cur.filter((s) => s.tabId !== input.tabId)
  const sessions = await setNetCaptureSessions([...rest, session])
  return {
    session,
    sessions,
    replaced: sameTab.map((s) => ({ ...s, endedAt: now })),
  }
}

/** 结束某标签页的全部会话（标签页关闭 / 用户点停止），返回的 ended 交由调用方归档 */
export async function stopNetSessionsByTab(
  tabId: number,
): Promise<{ sessions: NetRecordSession[]; ended: NetRecordSession[] }> {
  const cur = await getNetCaptureSessions()
  const ended = cur.filter((s) => s.tabId === tabId)
  if (!ended.length) return { sessions: cur, ended: [] }
  const now = Date.now()
  const sessions = await setNetCaptureSessions(cur.filter((s) => s.tabId !== tabId))
  return { sessions, ended: ended.map((s) => ({ ...s, endedAt: now })) }
}

/**
 * 对账：丢掉标签页已经不在的会话（返回的 ended 交由调用方归档）。
 *
 * SW 会被回收，账本只能落库；而标签页在 SW 睡着时关掉的话，onRemoved 要等 SW 醒来才补上——
 * 万一它再没醒（用户就此收工），库里就留着一份指向不存在标签页的门禁：注册集合虚扩，
 * 且那个 tabId 被别的页面复用后会被误判成「正在录」。故每次 SW 启动对账一遍。
 *
 * 存活集合由调用方传入：本模块不感知 chrome API（chrome.tabs 只该出现在 SW 侧）。
 */
export async function reconcileNetSessions(
  aliveTabIds: Set<number>,
): Promise<{ sessions: NetRecordSession[]; ended: NetRecordSession[] }> {
  const cur = await getNetCaptureSessions()
  const ended = cur.filter((s) => !aliveTabIds.has(s.tabId))
  if (!ended.length) return { sessions: cur, ended: [] }
  const now = Date.now()
  const sessions = await setNetCaptureSessions(cur.filter((s) => aliveTabIds.has(s.tabId)))
  return { sessions, ended: ended.map((s) => ({ ...s, endedAt: now })) }
}
