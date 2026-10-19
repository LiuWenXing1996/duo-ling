// 浮层宿主指令桥（SW 侧）：打开浮层与在岗探活两条。
//
// 超时只设在探活这一条（用户与右键菜单不等的那个「点了没反应」要能被判出来）：
// 件可能因页面卸载 / 导航而永不回话，留一条兜底。

import { FLOAT_HOST_ID, FLOAT_HOST_OPEN_COMMAND } from '@duoling/user-scripts/builtin'
import { pushCommandTo } from '../dl-port'
import { dlRuntimePort } from '../host-config'

/** 探活的超时：件在位时回话是毫秒级，到点没回就是不在位（页面在导航 / 件没注入） */
const PING_TIMEOUT_MS = 5_000

interface PendingPing {
  resolve: (v: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

/** 在进行中的探活：reqId → 结算器。SW 重启即丢（发起侧那次调用由超时收场） */
const pending = new Map<string, PendingPing>()

function mintReqId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `dlfloat-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** 展开浮层：走件的后台命令 `float.open`；false = 该页没有件的在岗连接（件没到位 / 页面在导航） */
export async function openFloatPanel(tabId: number): Promise<boolean> {
  const runtime = dlRuntimePort()
  if (!runtime) return false
  try {
    await runtime.invokeBackgroundCommand(tabId, FLOAT_HOST_ID, FLOAT_HOST_OPEN_COMMAND, { tabId })
    return true
  } catch {
    return false
  }
}

/**
 * 在岗探活：下发 ping 并等 float.pong，reqId 配对（与检查器的结算同款）。
 * 返回 false = 到点没回话 / 下发就没推到（件不在位）。
 */
export async function pingFloatHost(tabId: number): Promise<boolean> {
  const reqId = mintReqId()
  const wait = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(reqId)
      resolve(false)
    }, PING_TIMEOUT_MS)
    pending.set(reqId, { resolve, timer })
  })
  if (pushCommandTo(FLOAT_HOST_ID, tabId, { t: 'float.cmd', cmd: 'ping', reqId }) === 0) {
    const entry = pending.get(reqId)
    if (entry) {
      pending.delete(reqId)
      clearTimeout(entry.timer)
    }
    return false
  }
  return wait
}

/**
 * 件上报的在岗应答（dl-bridge 的 `__dlEvent` 分流交来；telemetry port 注入，见 telemetry.ts）。
 *
 * 旁证只认 **uuid**（信封上带着发件系统脚本的固定 uuid，不是浮层宿主自己的就丢弃出声）；
 * 结算认 **reqId**（SW 现造，页面与别的脚本都猜不到）。没对上挂起调用的：SW 重启过
 * （记账丢了），由发起侧超时收场。
 */
export function handleFloatEvent(
  uuid: string,
  _tabId: number | null,
  rec: { reqId: string },
): void {
  if (uuid !== FLOAT_HOST_ID) {
    console.warn('[duoling:float] 在岗应答来自别的脚本，丢弃：', uuid)
    return
  }
  const reqId = String(rec.reqId ?? '')
  const entry = pending.get(reqId)
  if (!entry) {
    // 有信封却没挂起的调用：SW 重启过（记账丢了）。真丢了的调用由超时兜底。
    console.warn('[duoling:float] 在岗应答没对上挂起的调用（SW 重启过）：', reqId)
    return
  }
  pending.delete(reqId)
  clearTimeout(entry.timer)
  entry.resolve(true)
}
