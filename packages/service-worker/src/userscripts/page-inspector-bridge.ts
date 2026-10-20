import type { PageEnvContext } from '@duoling/shared'
import { INSPECTOR_HOST_ID } from '@duoling/user-scripts/builtin'
import { pushCommandTo } from '../dl-port'

const COMMAND_TIMEOUT_MS = 60_000

const TIMEOUT_MESSAGE = {
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

function mintReqId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `dlinsp-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/**
 * 失败路径：下发时该页上没有件的在岗连接 → 立刻抛（不等超时）；件报错 → 抛件给的原因；
 * 永不结算 → 超时抛。
 */
export async function runInspectorCommand<T>(tabId: number, mode: InspectorMode): Promise<T> {
  const reqId = mintReqId()
  const wait = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId)
      reject(new Error(TIMEOUT_MESSAGE[mode]))
    }, COMMAND_TIMEOUT_MS)
    pending.set(reqId, { resolve, reject, timer })
  })
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
    throw new Error(NOT_READY)
  }
  return (await wait) as T
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

/**
 * 页面环境读数：静默读视口尺寸 / 设备像素比 / 页面里读到的 UA，不亮任何 UI。
 */
export async function capturePageEnvFromTab(tabId: number): Promise<PageEnvContext> {
  const ctx = await runInspectorCommand<PageEnvContext>(tabId, 'env')
  if (!ctx) throw new Error('页面环境读取失败：件未返回数据')
  return ctx
}
