// 对话界面「页面脚本监控」的 SW 侧逻辑（运行时口径）。
//
// 灵动岛显示的是「浮层所属标签页」的运行集（归属见 lib/owning-tab.ts，不跟随 active tab），必须有一个地方替它记住
// 「每个 tab 当前文档里跑着哪些脚本」——就是这个按 tab 的运行登记表。
//
// 数据流（三个信号源，全部已在 dl-bridge / background 里存在，这里只是多接一根线）：
//   · runstart 广播（GM 包装注入即发）→ noteRunStart：登记 + 推给所有打开的对话界面
//   · 运行错误落盘（__dlEvent 上报）→ notePageError：推给对话界面（错误本体随推送走，
//     面板不回查错误日志——落盘记录无 tabId，按 tab 归属只能靠这条实时通道）
//   · 新文档导航（tabs.onUpdated status=loading）→ resetPageRuns：旧文档销毁，运行集清零
//
// 快照：面板切 tab / 刚打开时上行 page:snapshot，SW 按登记表回当前运行集；
// 错误历史按 runId 从错误日志（runtime 库 errors store）反查（runtime 错误都带 runId）。
//
// 已知边界（刻意接受）：SW 被杀重启后登记表清空，且历史 runstart 不会重放
// （广播是即发即弃的）——面板在「SW 重启后、页面未重新导航」的窗口里会显示为空。
// 页面一刷新即恢复。

import type {
  PageErrorItem,
  PageRunItem,
  PanelMonitorPush,
  PanelMonitorUp,
} from '@/shared/extension-ipc'
import type { UserScriptErrorRecord } from './types'
import { listUserScriptErrors } from './store'

/** 面板端口名（复用面板存活端口：ChatApp 建连时用同一个名字，SW 侧两个监听者各取所需） */
const PANEL_PORT_NAME = 'duoling:panel'

/** 快照错误行的 message 截断（面板行内展示） */
const SNAPSHOT_ERROR_TRUNC = 200

/**
 * 运行登记表：tabId → (uuid → 运行项)。**这是 SW 唯一的监控状态**，随 tab 生命周期增删：
 * 新文档导航清空（resetPageRuns）、tab 关闭清除（forgetPageTab）、SW 重启自然丢失（见文件头边界）。
 * export 仅供单测直接断言登记行为。
 */
export const pageRunsByTab = new Map<number, Map<string, PageRunItem>>()

/** 已登记的对话界面端口（寻址表：浮层展开着才有；断开即摘）。与 background 的 panelPorts 独立——那边只管徽章。 */
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
}

/** 推送一条运行时错误（错误已由调用方落盘；这里只负责让面板实时可见） */
export function notePageError(
  tabId: number,
  error: { uuid: string | null; name: string; message: string; runId: string | null },
): void {
  pushToPanels({ t: 'page:error', tabId, error: { ...error, time: Date.now() } })
}

/** 新文档导航开始：清空该 tab 的运行集并通知面板（SPA 软导航不会走到这——不换文档） */
export function resetPageRuns(tabId: number): void {
  if (!pageRunsByTab.delete(tabId)) return
  pushToPanels({ t: 'page:reset', tabId })
}

/** tab 关闭：静默清除（面板自己也在监听 onRemoved，无需推送） */
export function forgetPageTab(tabId: number): void {
  pageRunsByTab.delete(tabId)
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
  const runs = [...(pageRunsByTab.get(tabId)?.values() ?? [])]
  let errors: PageErrorItem[] = []
  try {
    errors = pickErrorsForRuns(await listUserScriptErrors(), runs)
  } catch {
    // 错误日志读不出来就只回运行集（快照是尽力而为的面板数据，不值得失败）
  }
  return { runs, errors }
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
    if (port.name !== PANEL_PORT_NAME) return
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
      // 点击脚本行 → 打开/聚焦工作台错误日志
      if (msg.t === 'page:openErrors' && msg.uuid) void openWorkbenchErrors(msg.uuid).catch(() => {})
    })
  })
}

/**
 * 上行：点击脚本行 → 打开 / 聚焦工作台并深链定位到该脚本的错误（workbench.html#/errors/<uuid>）。
 * 已打开工作台时更新 hash 并激活（hash 变化不重载页面，WorkbenchApp 的 hash 处理器接管）。
 */
export async function openWorkbenchErrors(uuid: string): Promise<void> {
  const base = chrome.runtime.getURL('workbench.html')
  const url = `${base}#/errors/${encodeURIComponent(uuid)}`
  const tabs = await chrome.tabs.query({ url: `${base}*` })
  const existing = tabs.find((t) => t.id != null)
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { url, active: true })
    if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {})
  } else {
    await chrome.tabs.create({ url })
  }
}
