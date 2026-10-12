// 标签页存续的**取号处**：谁要「哪个标签页」的稳定身份，都从这里拿 tabSessionId
//（表的记录形状与字段语义见 TabSessionRecord；本模块只定「什么时候取号、什么时候盖章」）。
//
// 为什么需要稳定身份：tabId 是浏览器本次运行内的流水号 —— 易失、重启后重排、且会被复用，
// 只配当实时判据。把历史数据挂上去，重启后两段毫不相干的浏览会被记成一桶。
//
// **记录是主动与被动的分工**：不为「开了个标签页」建行 —— 那样每开一页都留一行，绝大多数
// 与脚本无关。行只在用户明确要求时建立：
//   · 用户在 popup 里给**这一页**打开活动记录 → 建行（recording: true），此后这一页的运行被记
//   · 脚本在这一页跑起来而要取号             → 只**复用**记着的那一行，没有就不取号（不建行）
// 关掉开关只撤 recording，行留着：历史不该被一次关开关抹掉。
//
// 维护已有行的四条线（都不建行，表里没这行就什么都不做）：
//   · `tabs.onUpdated` 带回 url   → 记一条「地址变更」，刷新「这个标签页最近去哪了」
//   · `tabs.onUpdated` status=loading → 记一条「页面刷新」，或补记「地址变更」
//                                   （两者怎么分见 noteTabReloaded）
//   · `tabs.onRemoved`            → 盖关闭时刻
//   · 浏览器启动（`runtime.onStartup`）→ 划断：把还开着的行盖章结束、时刻留空（理由见
//                                   runtime-db 的 endOpenTabSessions）
//
// 于是「有时刻」与「没时刻」在这张表里是常态并存的，读侧一律按可选处理，缺了就显示「未知」。
// `createdAt` 自被动化起**恒缺省**：建行的两个时机都不是标签页出生的时刻（见 TabSessionRecord）。

import {
  appendTabEvent,
  closeTabSession,
  endOpenTabSessions,
  findOpenTabSession,
  mintTabSession,
  setTabSessionRecording,
} from './runtime-db'

/**
 * tabId → 最近一次「地址变更」的时刻。
 *
 * 一次导航会让 url 与 status 两个回调先后（或合成一次）到来：url 那一支记下事件后在这里
 * 留个印，status 那一支看见印就知道「这次文档重开是刚才那次改地址的结果」，不再记一条刷新。
 *
 * 印带时效是因为 SPA 软导航永远等不到 status —— 印会一直留着，不设期限的话，几秒后的一次
 * 真刷新会被它误吞。两秒足够覆盖导航里两个回调的间隔。
 *
 * 只活在 SW 内存里：SW 被回收后印丢了，最坏是下一次导航多记一条刷新，不值得为它落盘。
 */
const navPending = new Map<number, number>()
const NAV_PENDING_MS = 2000

/**
 * 这一页正在记活动时，拿它的稳定身份；没在记（或表里没有这一页）返回 undefined。
 *
 * 运行记账的唯一取号口：**只复用、不建行** —— 没有号就等于这次运行没有标签页归属，
 * 读侧归「未知标签页」。这条是「被动」的全部含义。
 */
export async function recordingTabSessionId(tabId: number): Promise<string | undefined> {
  const open = await findOpenTabSession(tabId)
  return open?.recording === true ? open.tabSessionId : undefined
}

/**
 * 打开 / 关掉这一页的活动记录（popup 的开关）。
 *
 * 打开时表里没有这一页就建行 —— 开关是用户显式的意愿，建行让这一页立刻出现在活动历史里
 * （哪怕它此后一次脚本都没跑），顺手记下此刻的地址。
 *
 * 关掉只撤 recording、不删行：历史留着，只是不再长出新记录。
 */
export async function setTabRecording(tabId: number, on: boolean, url?: string): Promise<void> {
  if (on && !(await findOpenTabSession(tabId))) {
    await mintTabSession({ tabId, ...(url ? { url } : {}), recording: true })
    return
  }
  await setTabSessionRecording(tabId, on)
}

/**
 * 地址变了（`tabs.onUpdated` 带回 url）：记一条「地址变更」，并把行内地址更新为新值。
 *
 * 与行内地址相同就不动 —— 同一次导航会重复带回同一个 url，那是同一次变化，不该记两条。
 * 也正因为它按「与行内地址比较」去重，这条支天然覆盖 SPA 软导航（只改地址、不换文档，
 * 永远不会来 loading）。
 *
 * @returns 是否真记下了（没这一行、或地址没变 → false）
 */
export async function noteTabUrlChanged(tabId: number, url: string): Promise<boolean> {
  const row = await findOpenTabSession(tabId)
  if (!row || row.url === url) return false
  navPending.set(tabId, Date.now())
  return appendTabEvent(row.tabSessionId, 'url', url)
}

/**
 * 文档重新开始（`tabs.onUpdated` 的 status = loading）：判它是一次「刷新」还是一次「导航」。
 *
 * 判据是**行内地址与此刻地址是否一致**，而不是这一次回调带没带 url：同一导航的 url 回调与
 * status 回调谁先到并不确定（也可能合成一次，也可能 url 先到），只有拿此刻的真实地址去比
 * 才对顺序免疫 —— 回调带不带 url 只说明「浏览器这次顺手报了什么」，不说明地址变没变。
 *
 * 三种走向：
 *   · 刚记过地址变更（印未过期）→ 这次 loading 是它的后续，不记（否则一次导航落两条）
 *   · 地址确实变了（url 回调还没到）→ 记「地址变更」，别把导航说成刷新
 *   · 其余（地址没变、或取不到地址）→ 记「页面刷新」
 *
 * @param url 此刻的地址，由调用方现取 —— 只有 SW 拿得到（取不到就是 undefined，
 *   那种情况下按「刷新」记：文档确实重开了，只是地址无从比较）
 * @returns 是否真记下了（没这一行 → false）
 */
export async function noteTabReloaded(tabId: number, url?: string): Promise<boolean> {
  const row = await findOpenTabSession(tabId)
  if (!row) return false
  const pendingAt = navPending.get(tabId)
  if (pendingAt !== undefined) {
    navPending.delete(tabId)
    if (Date.now() - pendingAt < NAV_PENDING_MS) return false
  }
  if (url && row.url && url !== row.url) return appendTabEvent(row.tabSessionId, 'url', url)
  return appendTabEvent(row.tabSessionId, 'reload', url)
}

/** 标签页关闭（`tabs.onRemoved`）：盖关闭时刻。没登记过的标签页不补行 */
export async function noteTabClosed(tabId: number): Promise<void> {
  navPending.delete(tabId)
  await closeTabSession(tabId, Date.now())
}

/** 浏览器启动划断（`runtime.onStartup`）：见 runtime-db 的 endOpenTabSessions */
export function splitTabSessionsAtBrowserStart(): Promise<number> {
  return endOpenTabSessions()
}

// —— 测试辅助（仅单测使用）——

/**
 * 清掉内存里的导航印记。
 *
 * 印记是 **SW 进程内存态**，不落库 —— 清库清不掉它，于是用例之间会互相串味：前一个用例
 * 在同一 tabId 上记过地址变更，后一个用例的「刷新」就会被那枚没被消费掉的旧印吞掉。
 * 单测的 beforeEach 必须连它一起清，否则失败原因会指向一个根本不存在的判定 bug。
 */
export function resetTabNavPendingForTests(): void {
  navPending.clear()
}
