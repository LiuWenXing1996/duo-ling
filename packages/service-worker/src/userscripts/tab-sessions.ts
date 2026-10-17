// 标签页存续的**取号处**：谁要「哪个标签页」的稳定身份，都从这里拿 tabSessionId
//（表的记录形状与字段语义见 TabSessionRecord；本模块只定「什么时候取号、什么时候盖章」）。
//
// 为什么需要稳定身份：tabId 是浏览器本次运行内的流水号 —— 易失、重启后重排、且会被复用，
// 只配当实时判据。把历史数据挂上去，重启后两段毫不相干的浏览会被记成一桶。
//
// **记录是被动的**：不为「开了个标签页」建行，只在用户给这一页打开活动记录时建行；
// 运行记账只复用记着的那一行（开关留痕、四条维护线、启动划断与时刻口径，
// 见 ARCHITECTURE.md「存储」节的标签页存续）。

import {
  appendTabEvent,
  closeTabSession,
  endDeadTabSessions,
  endOpenTabSessions,
  findOpenTabSession,
  mintTabSession,
  setTabSessionRecording,
} from './runtime-db'
import { broadcastDataChange } from '@duoling/shared'

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
 *
 * 两种切换都在这一页的时间线上落一条（开始记录 / 结束记录），与落盘同事务 —— 由 runtime-db
 * 的 mintTabSession / setTabSessionRecording 一并完成，这里只管「什么时候该切」。
 */
export async function setTabRecording(
  tabId: number,
  on: boolean,
  url?: string,
): Promise<string | undefined> {
  // 结构性变化（建行 / 撤号）一律**不带 uuid** 地广播：读侧据此全量重拉 —— 行的增删会让
  // 增量游标指向一段已经不存在的轴，那种情况下必须整根重读。
  if (on && !(await findOpenTabSession(tabId))) {
    const minted = await mintTabSession({ tabId, ...(url ? { url } : {}), recording: true })
    broadcastDataChange('tabActivity')
    return minted
  }
  const changed = await setTabSessionRecording(tabId, on)
  if (changed) broadcastDataChange('tabActivity')
  // 开的时候要把这一行的 id 交出去：接口录制挂在同一个开关上，它的归属就是这一行
  return on ? (await findOpenTabSession(tabId))?.tabSessionId : undefined
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
  const written = await appendTabEvent(row.tabSessionId, 'url', url)
  if (written) broadcastDataChange('tabActivity', row.tabSessionId)
  return written
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
  const kind = url && row.url && url !== row.url ? 'url' : 'reload'
  const written = await appendTabEvent(row.tabSessionId, kind, url)
  if (written) broadcastDataChange('tabActivity', row.tabSessionId)
  return written
}

/** 标签页关闭（`tabs.onRemoved`）：盖关闭时刻。没登记过的标签页不补行 */
export async function noteTabClosed(tabId: number): Promise<void> {
  navPending.delete(tabId)
  // 盖章结束改的是**行本身**（不是轴的某一行），故不带 uuid：读侧要连左栏一起重算
  if (await closeTabSession(tabId, Date.now())) broadcastDataChange('tabActivity')
}

/** 浏览器启动划断（`runtime.onStartup`）：见 runtime-db 的 endOpenTabSessions */
export async function splitTabSessionsAtBrowserStart(): Promise<number> {
  const stamped = await endOpenTabSessions()
  if (stamped > 0) broadcastDataChange('tabActivity')
  return stamped
}

/**
 * SW 冷启动对账：把「还开着、但 tabId 已不存在」的行盖章结束。
 *
 * 存活集合由调用方传入：本模块不感知 chrome API（`chrome.tabs` 只该出现在 SW 侧）。
 * 必须在重注册之前调用 —— 否则这一步算出来的注册集合是过期的那一份。
 */
export async function reconcileDeadTabSessions(aliveTabIds: Set<number>): Promise<number> {
  const stamped = await endDeadTabSessions(aliveTabIds)
  if (stamped > 0) broadcastDataChange('tabActivity')
  return stamped
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
