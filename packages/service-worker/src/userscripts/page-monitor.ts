// 「页面脚本监控」的 SW 侧逻辑（运行时口径）——三处共用同一份按 tab 的运行登记表：
// 对话界面灵动岛、工具栏角标、popup 的页面概览（三处怎么取数见 ARCHITECTURE.md「脚本注入」节）。
//
// 本文件的活：三个信号源（runstart 广播 → noteRunStart / 运行错误落盘 → notePageError /
// 新文档导航 → resetPageRuns 清零）接进登记表，变化时喊 onPageRunsChanged
//（角标只能由这里推着重算，面板另有快照可拉）；错误历史按 runId 从 tab_events 反查，
// 能查到什么受写侧判据约束（未开记录的页 = 观测盲区，与「只观测开着记录的页」同一口径）。
// 已知边界（内存表，扩展重载 / 浏览器启动后为空且 runstart 不重放）见 ARCHITECTURE.md「脚本注入」节。
// 端口名与载荷形状归契约包（@duoling/shared 的 panel-monitor.ts）：面板侧也认同一份。

// 端口名与载荷形状归契约包（@duoling/shared 的 panel-monitor.ts）：面板侧也认同一份。
import { PANEL_MONITOR_PORT } from '@duoling/shared'
import type {
  PageErrorItem,
  PageRunItem,
  PanelMonitorPush,
  PanelMonitorUp,
  UserScriptErrorRecord,
} from '@duoling/shared'
import { listUserScriptErrors } from './store'

/** 快照错误行的 message 截断（面板行内展示） */
const SNAPSHOT_ERROR_TRUNC = 200

/**
 * 运行登记表：tabId → (uuid → 运行项)。**这是 SW 唯一的监控状态**，随 tab 生命周期增删：
 * 新文档导航清空（resetPageRuns）、tab 关闭清除（forgetPageTab）、扩展重载自然丢失（见文件头边界）。
 * export 仅供单测直接断言登记行为。
 */
export const pageRunsByTab = new Map<number, Map<string, PageRunItem>>()

/**
 * 登记表变化的订阅者（角标重算挂在它上面）。
 *
 * 为什么是订阅而不是让写方直接去设角标：写方在 dl-bridge（SW 与 dl-bridge 互相 import 会成环），
 * 而「登记表变了」这个事实只属于本模块。
 */
const runsChangeListeners = new Set<() => void>()

/** 订阅登记表变化（登记 / 清零 / tab 关闭各喊一次）。无退订：消费方是常驻的 SW 侧一处 */
export function onPageRunsChanged(listener: () => void): void {
  runsChangeListeners.add(listener)
}

/** 通知订阅者。单个订阅者抛错不该反噬写方，也不该拖住其它订阅者 */
function notifyRunsChanged(): void {
  for (const listener of runsChangeListeners) {
    try {
      listener()
    } catch {
      // 忽略：角标重算是它的私事
    }
  }
}

/**
 * 已登记的面板端口（寻址表：面板文档活着才有；断开即摘）。
 * 注意这条**不代表「浮层展开着」**——收起浮层只是 display:none，面板文档照活着。
 */
const monitorPorts = new Set<chrome.runtime.Port>()

/** 推一条给所有打开的对话界面；端口已断（SW 重启竞态）就静默摘除 */
function pushToPanels(payload: PanelMonitorPush): void {
  for (const port of monitorPorts) {
    try {
      port.postMessage(payload)
    } catch {
      monitorPorts.delete(port)
    }
  }
}

/** 登记一次运行（同 uuid 重复广播 = 覆盖为最新 runId）并实时推送 */
export function noteRunStart(tabId: number, uuid: string, runId: string): void {
  const run: PageRunItem = { uuid, runId, startedAt: Date.now() }
  let runs = pageRunsByTab.get(tabId)
  if (!runs) {
    runs = new Map()
    pageRunsByTab.set(tabId, runs)
  }
  runs.set(uuid, run)
  pushToPanels({ t: 'page:runstart', tabId, run })
  notifyRunsChanged()
}

/** 推送一条运行时错误（错误已由调用方落盘；这里只负责让面板实时可见） */
export function notePageError(
  tabId: number,
  error: { uuid: string | null; name: string; message: string; runId: string | null },
): void {
  pushToPanels({ t: 'page:error', tabId, error: { ...error, time: Date.now() } })
}

/** 新文档导航开始：清空该 tab 的运行集并通知面板 / 角标（SPA 软导航不会走到这——不换文档） */
export function resetPageRuns(tabId: number): void {
  if (!pageRunsByTab.delete(tabId)) return
  pushToPanels({ t: 'page:reset', tabId })
  notifyRunsChanged()
}

/** tab 关闭：静默清除（面板自己也在监听 onRemoved，无需推送；角标随标签页消失，仅需重算账面） */
export function forgetPageTab(tabId: number): void {
  if (!pageRunsByTab.delete(tabId)) return
  notifyRunsChanged()
}

/** 纯函数内核（导出便于单测）：按运行集的 runId 过滤出相关错误，收窄成面板行。 */
export function pickErrorsForRuns(
  errors: UserScriptErrorRecord[],
  runs: PageRunItem[],
): PageErrorItem[] {
  const runIds = new Set(runs.map((r) => r.runId))
  return errors
    .filter((e) => e.runId != null && runIds.has(e.runId))
    .map((e) => ({
      uuid: e.uuid,
      name: e.name,
      message: e.message.slice(0, SNAPSHOT_ERROR_TRUNC),
      time: e.time,
      runId: e.runId ?? null,
    }))
}

/** 组一份快照应答：运行集来自登记表，错误按 runId 从错误日志（runtime 库）反查 */
export async function snapshotFor(tabId: number): Promise<{
  runs: PageRunItem[]
  errors: PageErrorItem[]
}> {
  const byTab = await snapshotForTabs([tabId])
  return byTab.get(tabId) ?? { runs: [], errors: [] }
}

/**
 * 一次给多个标签页组快照（popup 的页面概览用）：错误日志**只读一次**，再按各 tab 的运行集分配。
 * 逐 tab 调 snapshotFor 会各读一次同一个库 —— 标签页一多就是 N 次全量读。
 */
export async function snapshotForTabs(
  tabIds: number[],
): Promise<Map<number, { runs: PageRunItem[]; errors: PageErrorItem[] }>> {
  let allErrors: UserScriptErrorRecord[] = []
  try {
    allErrors = await listUserScriptErrors()
  } catch {
    // 错误日志读不出来就只给运行集（快照是尽力而为的面板数据，不值得失败）
  }
  const out = new Map<number, { runs: PageRunItem[]; errors: PageErrorItem[] }>()
  for (const tabId of tabIds) {
    const runs = [...(pageRunsByTab.get(tabId)?.values() ?? [])]
    out.set(tabId, { runs, errors: pickErrorsForRuns(allErrors, runs) })
  }
  return out
}

/**
 * 监控端口监听（SW 启动时挂一次）：登记 / 断开清理 / 上行快照请求。
 *
 * ⚠️ 必须由 defineBackground 调用：本模块会被单测间接触达，
 * 测试环境没有完整 runtime.onConnect，顶层挂载会炸。
 */
export function initPageMonitorPorts(): void {
  if (typeof chrome.runtime?.onConnect?.addListener !== 'function') return
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_MONITOR_PORT) return
    monitorPorts.add(port)
    port.onDisconnect.addListener(() => monitorPorts.delete(port))
    port.onMessage.addListener((raw) => {
      const msg = raw as PanelMonitorUp | undefined
      if (!msg) return
      if (msg.t === 'page:snapshot' && typeof msg.tabId === 'number') {
        void snapshotFor(msg.tabId)
          .then((snap) => {
            try {
              port.postMessage({ t: 'page:snapshot', tabId: msg.tabId, ...snap } satisfies PanelMonitorPush)
            } catch {
              // 面板恰好在回包前关掉：丢弃
            }
          })
          .catch(() => {})
        return
      }
    })
  })
}
