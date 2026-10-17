// 页面脚本监控 · 面板端口协议（`duoling:panel`）。
//
// 一条长连接两个方向：SW → 面板推送（运行登记 / 错误 / 新文档清零 / 快照应答），
// 面板 → SW 上行（按自己所属的 tab 拉一次快照）。
//
// 为什么住契约包：两端各在一个进程里 —— SW 侧是本包 userscripts/page-monitor.ts，
// 另一端是对话界面浮层的 use-page-monitor.ts（应用侧）。端口名或载荷形状只在一端改，
// 另一端不会报错，只会静默收不到东西。
//
// 与 RuntimeRequest 的分工：那是**请求-应答命令面**，这条是长连接推送 —— 不进那个联合，
// 也不占总线 matcher（面板端口由 SW 自己 onConnect 接）。

/** 监控端口名：面板经 `runtime.connect({ name: PANEL_MONITOR_PORT })` 建连 */
export const PANEL_MONITOR_PORT = 'duoling:panel'

/** 当前 tab 的一次运行（一次页面加载 = 一个 runId；SPA 软导航不换文档、runId 不变） */
export interface PageRunItem {
  uuid: string
  runId: string
  startedAt: number
}

/** 面板展示的错误行（只含与本 tab 运行集相关的 runtime 错误；message 已截断） */
export interface PageErrorItem {
  uuid: string | null
  name: string
  message: string
  time: number
  runId: string | null
}

/** SW → 面板的监控推送 */
export type PanelMonitorPush =
  /** 脚本注入即广播：登记一次运行 */
  | { t: 'page:runstart'; tabId: number; run: PageRunItem }
  /** 运行时错误落盘后同步推送 */
  | { t: 'page:error'; tabId: number; error: PageErrorItem }
  /** 新文档导航开始：该 tab 的运行集清零（SPA 软导航不触发——不换文档） */
  | { t: 'page:reset'; tabId: number }
  /** 快照应答：该 tab 的运行集 + 关联错误（面板切 tab / 建连时拉取） */
  | { t: 'page:snapshot'; tabId: number; runs: PageRunItem[]; errors: PageErrorItem[] }

/** 面板 → SW 的监控上行（同端口） */
export type PanelMonitorUp =
  /** 按面板自己归属的那个 tab 拉快照（面板刚打开 / 挂载时；归属怎么定见 lib/owning-tab.ts） */
  | { t: 'page:snapshot'; tabId: number }
