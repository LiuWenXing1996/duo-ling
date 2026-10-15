// 页面检查器指令桥（SW 侧）：把「拾取 / 采集快照 / 读环境 / 收工」下发到常驻件，
// 并在件上报结果时按 reqId 配对回发起方那次调用。
//
// 只在 SW 侧引用（发起方是浮层或 SW 自己）。与 element-picker-client 的分工：
//   client —— 发起侧薄客户端：发命令、等应答、把失败文案交给 UI；
//   本文件 —— SW 侧那半：下发、配对、超时兜底、进行中拾取的记账。
//
// 件已是 MAIN 世界系统脚本（走统一脚本链，见 system-scripts.ts），通道全走脚本桥：
//   · 下行 —— DL Port 事件帧 `inspector.cmd`（按系统脚本 uuid + tabId 寻址，pushCommandTo）；
//   · 上行 —— `__dlEvent` 信封 `inspector.result`，dl-bridge 分流后交 handleInspectorEvent
//     （telemetry port 注入，见 telemetry.ts）。
//
// 超时放在这一层（不重复设在发起侧）：件可能因页面卸载 / 导航而永远不上报，留一条兜底，
// 文案按模式区分 —— 用户要能判断是「自己没点」还是「页面没了」。

import { INSPECTOR_HOST_ID } from '@duoling/builtin-scripts'
import { pushCommandTo } from '@duoling/userscript-runtime'

/** 单次调用的超时：用户点选可能很久不结算，但页面关掉 / 导航会让它永不结算，必须有兜底 */
const PICK_TIMEOUT_MS = 60_000

/** 各模式的超时文案（超时 = 这次调用失败，文案要能让用户判断是「没点」还是「页面没了」） */
const TIMEOUT_MESSAGE = {
  pick: '拾取已取消：60 秒内未完成点选（页面可能已关闭或刷新）',
  snapshot: '页面快照采集失败：60 秒内未完成（页面可能已关闭或刷新）',
  env: '页面环境读取失败：60 秒内未完成（页面可能已关闭或刷新）',
} as const

export type InspectorMode = keyof typeof TIMEOUT_MESSAGE

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
}

/** 在进行中的指令：reqId → 结算器。SW 重启即丢（发起侧那条连接也一并断） */
const pending = new Map<string, PendingInspector>()

/** 进行中拾取的目标标签页（收工要往那一页发）。同一时刻至多一个拾取，与 UI 的单一入口一致 */
let activePickTabId: number | null = null

function mintReqId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `dlinsp-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/**
 * 下发一条指令并等件上报结果。pick 模式结算值可为 null（用户取消），其余模式结算值必为对象。
 * 失败路径：下发时该页上没有件的在岗连接 → 立刻抛（不等超时）；件报错 → 抛件给的原因；
 * 永不结算 → 超时抛。
 */
export async function runInspectorCommand<T>(tabId: number, mode: InspectorMode): Promise<T | null> {
  const reqId = mintReqId()
  const wait = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId)
      reject(new Error(TIMEOUT_MESSAGE[mode]))
    }, PICK_TIMEOUT_MS)
    pending.set(reqId, { resolve, reject, timer })
  })
  if (mode === 'pick') activePickTabId = tabId
  // 下行走 DL Port 事件帧：0 = 该页上没有件的在岗连接（没注册 / 没到位 / 导航中）。
  // 即时失败并清记账 —— 这条 wait 不会再有人 await，留着只会得到一条
  // 「拒绝却无人处理」的 Promise（控制台噪音），而不是给用户任何信息。
  const sent = pushCommandTo(INSPECTOR_HOST_ID, tabId, { t: 'inspector.cmd', cmd: mode, reqId })
  if (!sent) {
    const entry = pending.get(reqId)
    if (entry) {
      pending.delete(reqId)
      clearTimeout(entry.timer)
    }
    if (mode === 'pick') activePickTabId = null
    throw new Error(NOT_READY)
  }
  try {
    return (await wait) as T | null
  } finally {
    if (mode === 'pick') activePickTabId = null
  }
}

/**
 * 请件收工。不单独等回执：取消会让那条 pick 的 Promise resolve null，结果照常由它上报。
 * 该页上没有件的在岗连接时下发不了 —— 那条 pick 由超时兜底，这里静默。
 */
export async function cancelPicker(): Promise<void> {
  const tabId = activePickTabId
  if (tabId == null) return
  try {
    pushCommandTo(INSPECTOR_HOST_ID, tabId, {
      t: 'inspector.cmd',
      cmd: 'cancel',
      reqId: mintReqId(),
    })
  } catch {
    // 同上：静默，交给超时
  }
}

/**
 * 件上报的指令结果（dl-bridge 的 `__dlEvent` 分流交来；telemetry port 注入，见 telemetry.ts）。
 *
 * 认领与结算分开看：
 *   · 旁证只认 **uuid** —— 信封上带着发件系统脚本的固定 uuid，不是检查器自己的就丢弃出声；
 *   · 结算认 **reqId** —— 它由 SW 现造（UUID），页面与别的脚本都猜不到，配上了就是当次
 *     调用的回执。有信封却没挂起的调用：SW 重启过（记账丢了）。结算按 reqId 幂等，
 *     真丢了的调用由超时兜底。
 */
export function handleInspectorEvent(
  uuid: string,
  _tabId: number | null,
  rec: { reqId: string; ok: boolean; payload: unknown },
): void {
  if (uuid !== INSPECTOR_HOST_ID) {
    console.warn('[duoling:inspector] 指令结果来自别的脚本，丢弃：', uuid)
    return
  }
  const reqId = String(rec.reqId ?? '')
  const entry = pending.get(reqId)
  if (!entry) {
    // 有信封却没挂起的调用：SW 重启过（记账丢了）。真丢了的调用由超时兜底。
    console.warn('[duoling:inspector] 指令结果没对上挂起的调用（SW 重启过）：', reqId)
    return
  }
  pending.delete(reqId)
  clearTimeout(entry.timer)
  if (rec.ok === true) {
    entry.resolve(rec.payload ?? null)
  } else {
    entry.reject(new Error(typeof rec.payload === 'string' ? rec.payload : '页面读取失败'))
  }
}
