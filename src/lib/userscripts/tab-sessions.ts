// 标签页存续的**取号处**：谁要「哪个标签页」的稳定身份，都从这里拿 tabSessionId
//（表的记录形状与字段语义见 TabSessionRecord；本模块只定「什么时候取号、什么时候盖章」）。
//
// 为什么需要稳定身份：tabId 是浏览器本次运行内的流水号 —— 易失、重启后重排、且会被复用，
// 只配当实时判据。把历史数据挂上去，重启后两段毫不相干的浏览会被记成一桶。
//
// 取号与盖章的时机（刻意最省，不做任何对账扫描）：
//   · `tabs.onCreated`           → 建行 + 记出生时刻（这是唯一拿得到 createdAt 的入口）
//   · 别处要号而表里没有           → 就地建行，**出生时刻留空**（没看着它出生就是不知道，
//                                   不拿「发现它的时刻」冒充 —— 那会让字段名撒谎）
//   · `tabs.onUpdated` 带回 url   → 刷新「这个标签页最近去哪了」
//   · `tabs.onRemoved`            → 盖关闭时刻；表里没这行就什么都不做（没登记过的标签页
//                                   不需要一条幽灵行）
//   · 浏览器启动（`runtime.onStartup`）→ 划断：把还开着的行盖章结束、时刻留空（理由见
//                                   runtime-db 的 endOpenTabSessions）
//
// 于是「有时刻」与「没时刻」在这张表里是常态并存的，读侧一律按可选处理，缺了就显示「未知」。

import {
  closeTabSession,
  endOpenTabSessions,
  findOpenTabSession,
  mintTabSession,
  setTabSessionUrl,
} from './runtime-db'

/**
 * 取这个标签页的稳定身份；表里还没有它就地建一行（出生时刻留空）。
 *
 * 写入侧（运行日志记账）与实时侧（按标签页看现状）都要用它 —— 有它之后，
 * 其他面就不再需要 tabId 这种只在本会话内成立的判据。
 *
 * @param url 顺手带上的当前地址（拿得到就记，拿不到就算了）
 */
export async function tabSessionIdFor(tabId: number, url?: string): Promise<string> {
  const open = await findOpenTabSession(tabId)
  if (open) return open.tabSessionId
  return mintTabSession({ tabId, ...(url ? { url } : {}) })
}

/**
 * 新标签页出生（`tabs.onCreated`）：建行并记下出生时刻。
 *
 * 此刻可能还没有地址（新标签页还没开始导航），url / pendingUrl 都拿不到就空着。
 * 同一 tabId 已有未结束的行 = 重复事件或 tabId 复用（后者已被启动划断挡住），不重复建号。
 */
export async function noteTabCreated(tabId: number, url?: string): Promise<void> {
  const open = await findOpenTabSession(tabId)
  if (open) return
  await mintTabSession({ tabId, ...(url ? { url } : {}), createdAt: Date.now() })
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
