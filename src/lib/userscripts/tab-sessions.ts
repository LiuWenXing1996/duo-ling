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
// 维护已有行的三条线（都不建行，表里没这行就什么都不做）：
//   · `tabs.onUpdated` 带回 url   → 刷新「这个标签页最近去哪了」
//   · `tabs.onRemoved`            → 盖关闭时刻
//   · 浏览器启动（`runtime.onStartup`）→ 划断：把还开着的行盖章结束、时刻留空（理由见
//                                   runtime-db 的 endOpenTabSessions）
//
// 于是「有时刻」与「没时刻」在这张表里是常态并存的，读侧一律按可选处理，缺了就显示「未知」。
// `createdAt` 自被动化起**恒缺省**：建行的两个时机都不是标签页出生的时刻（见 TabSessionRecord）。

import {
  closeTabSession,
  endOpenTabSessions,
  findOpenTabSession,
  mintTabSession,
  setTabSessionRecording,
  setTabSessionUrl,
} from './runtime-db'

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

/** 这个标签页跳到了新地址（`tabs.onUpdated` 带回 url）：刷新「最近去哪了」 */
export async function noteTabUrl(tabId: number, url: string): Promise<void> {
  await setTabSessionUrl(tabId, url)
}

/** 标签页关闭（`tabs.onRemoved`）：盖关闭时刻。没登记过的标签页不补行 */
export async function noteTabClosed(tabId: number): Promise<void> {
  await closeTabSession(tabId, Date.now())
}

/** 浏览器启动划断（`runtime.onStartup`）：见 runtime-db 的 endOpenTabSessions */
export function splitTabSessionsAtBrowserStart(): Promise<number> {
  return endOpenTabSessions()
}
