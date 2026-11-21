// 页面检查器指令桥（SW 侧）：把「拾取 / 采集快照 / 读环境 / 收工」下发到常驻件，
// 并在件上报结果时按 reqId 配对回发起方那次调用。
// 两条支路：快照 / 环境读数由本层等结果（调用方是 AI 工具）；拾取下发即返回，结论交给 pending-pick。
//
// 件已是 MAIN 世界系统脚本（走统一脚本链，见 system-scripts.ts），通道全走脚本桥：
//     （telemetry port 注入，见 telemetry.ts）。
//
// 超时放在这一层（不重复设在发起侧）：件可能因页面卸载 / 导航而永远不上报，留一条兜底，
// 文案按模式区分 —— 用户要能判断是「自己没点」还是「页面没了」。

import type {
  ElementPickContext,
  PageEnvContext,
  PageFrameSnapshotContext,
  PageSnapshotContext,
} from '@duoling/shared'
import { INSPECTOR_HOST_ID } from '@duoling/user-scripts/builtin'
import { getGmPortRegistry, pushCommandTo, pushEvent } from '../gm-port'
import { clearFlight, findFlightTab, readPickState, recordFlight, settlePick } from './pending-pick'

const INSPECTOR_TIMEOUT_MS = 60_000

/** 各模式的超时文案（超时 = 这次调用失败，文案要能让用户判断是「没点」还是「页面没了」） */
const TIMEOUT_MESSAGE = {
  snapshot: '页面快照采集失败：60 秒内未完成（页面可能已关闭或刷新）',
  env: '页面环境读取失败：60 秒内未完成（页面可能已关闭或刷新）',
  frame: '该 frame 读取失败：60 秒内未完成（它可能已重载、被移除，或页面已刷新）',
} as const

export type InspectorMode = Exclude<keyof typeof TIMEOUT_MESSAGE, 'frame'>

const FRAME_GONE = '该 frame 已重载或已移除：请重新 page_snapshot 拿最新的 connId'

/**
 * 件不在位时的文案。触发它的情形都长一个样（下发时该页上没有件的在岗连接）：扩展侧开关没开
 * （件根本没注册成）、目标页尚在加载（件还没到位）、页面在导航中（旧件已卸）。
 * 不逐条猜原因 —— 用户能做的是那条开关，其余「稍后重试」即可。
 */
const NOT_READY =
  '页面检查器未就绪：需先开启「允许运行用户脚本」（工作台「引导」标签页有开启步骤），或稍后重试'

interface PendingInspector {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  tabId: number | null
}

/** 在进行中的指令：reqId → 结算器。SW 重启即丢（发起侧那条连接也一并断） */
const pending = new Map<string, PendingInspector>()

function mintReqId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `dlinsp-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function waitFor(reqId: string, timeoutMessage: string, tabId: number | null): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId)
      reject(new Error(timeoutMessage))
    }, INSPECTOR_TIMEOUT_MS)
    pending.set(reqId, { resolve, reject, timer, tabId })
  })
}

function dropPending(reqId: string): void {
  const entry = pending.get(reqId)
  if (!entry) return
  pending.delete(reqId)
  clearTimeout(entry.timer)
}

/**
 * 失败路径：下发时该页上没有件的在岗连接 → 立刻抛（不等超时）；件报错 → 抛件给的原因；
 * 永不结算 → 超时抛。
 */
export async function runInspectorCommand<T>(tabId: number, mode: InspectorMode): Promise<T> {
  const reqId = mintReqId()
  const wait = waitFor(reqId, TIMEOUT_MESSAGE[mode], tabId)
  const sent = pushCommandTo(INSPECTOR_HOST_ID, tabId, { t: 'inspector.cmd', cmd: mode, reqId })
  if (!sent) {
    dropPending(reqId)
    throw new Error(NOT_READY)
  }
  return (await wait) as T
}

export async function startPick(tabId: number): Promise<{ started: boolean }> {
  const { status } = await readPickState(tabId)
  if (status === 'picking') return { started: false }
  const reqId = mintReqId()
  await recordFlight(tabId, reqId, Date.now())
  const sent = pushCommandTo(INSPECTOR_HOST_ID, tabId, { t: 'inspector.cmd', cmd: 'pick', reqId })
  if (!sent) {
    await clearFlight(tabId, reqId)
    throw new Error(NOT_READY)
  }
  return { started: true }
}

export async function cancelPicker(tabId: number): Promise<void> {
  try {
    pushCommandTo(INSPECTOR_HOST_ID, tabId, {
      t: 'inspector.cmd',
      cmd: 'cancel',
      reqId: mintReqId(),
    })
  } catch {
    return
  }
}

/**
 * 认领与结算分开看：
 *   · 旁证只认 **uuid** —— 信封上带着发件系统脚本的固定 uuid，不是检查器自己的就丢弃出声；
 *   · 结算认 **reqId** —— 它由 SW 现造（UUID），页面与别的脚本都猜不到，配上了就是当次调用。
 */
export function handleInspectorEvent(
  uuid: string,
  tabId: number | null,
  rec: { reqId: string; ok: boolean; payload: unknown },
): void {
  if (uuid !== INSPECTOR_HOST_ID) {
    console.warn('[duoling:inspector] 指令结果来自别的脚本，丢弃：', uuid)
    return
  }
  const reqId = String(rec.reqId ?? '')
  const entry = pending.get(reqId)
  if (entry) {
    pending.delete(reqId)
    clearTimeout(entry.timer)
    if (entry.tabId != null && tabId != null && tabId !== entry.tabId) {
      console.warn(
        `[duoling:inspector] 回执来自别的标签页，丢弃：期望 ${entry.tabId}，实际 ${tabId}`,
      )
      entry.reject(new Error('页面读取结果来自别的标签页，已丢弃（请重新读取目标页）'))
      return
    }
    if (rec.ok === true) {
      entry.resolve(rec.payload ?? null)
    } else {
      entry.reject(new Error(typeof rec.payload === 'string' ? rec.payload : '页面读取失败'))
    }
    return
  }
  void settlePickFromEvent(reqId, rec)
}

async function settlePickFromEvent(
  reqId: string,
  rec: { ok: boolean; payload: unknown },
): Promise<void> {
  const cancelEcho = rec.ok === true && rec.payload == null
  const tabId = await findFlightTab(reqId)
  if (tabId == null) {
    if (!cancelEcho)
      console.warn('[duoling:inspector] 指令结果没对上挂起的调用（SW 重启过）：', reqId)
    return
  }
  try {
    if (rec.ok === true && rec.payload == null) {
      await clearFlight(tabId, reqId)
      return
    }
    if (rec.ok === true) {
      await settlePick(tabId, reqId, { element: rec.payload as ElementPickContext })
      return
    }
    await settlePick(tabId, reqId, {
      message: typeof rec.payload === 'string' ? rec.payload : '页面读取失败',
    })
  } finally {
    void cancelPicker(tabId)
  }
}

/**
 * 页面快照：静默抓渲染后 outerHTML（件内截断 ~32KB），不亮任何 UI。
 * 调用方 = SW 的 'page:snapshot' 命令（AI 的 page_snapshot 工具触发）；tabId 由调用方定位
 * （按会话归属反查，兜底最后聚焦窗口的激活页），本函数只管下发与取载荷。
 * 引擎可用性由调用方先判 —— 文案留应用侧一处，别在这里再写一句。
 */
export async function capturePageSnapshotFromTab(tabId: number): Promise<PageSnapshotContext> {
  return runInspectorCommand<PageSnapshotContext>(tabId, 'snapshot')
}

function framePort(tabId: number, connId: string): chrome.runtime.Port | null {
  for (const [port, meta] of getGmPortRegistry().meta) {
    if (meta.uuid === INSPECTOR_HOST_ID && meta.connId === connId && meta.tabId === tabId) {
      return port
    }
  }
  return null
}

export async function capturePageFrameFromTab(
  tabId: number,
  connId: string,
): Promise<PageFrameSnapshotContext> {
  const target = framePort(tabId, connId)
  if (!target) throw new Error(FRAME_GONE)
  const reqId = mintReqId()
  const wait = waitFor(reqId, TIMEOUT_MESSAGE.frame, tabId)
  pushEvent(getGmPortRegistry(), target, { t: 'inspector.cmd', cmd: 'frame', reqId })
  return (await wait) as PageFrameSnapshotContext
}

/**
 * 页面环境读数：静默读视口尺寸 / 设备像素比 / 页面里读到的 UA，不亮任何 UI。
 * 调用方 = SW 的 'page:env' 命令（AI 的 page_env_read 工具触发）；tabId 口径与快照一致。
 */
export async function capturePageEnvFromTab(tabId: number): Promise<PageEnvContext> {
  return runInspectorCommand<PageEnvContext>(tabId, 'env')
}
