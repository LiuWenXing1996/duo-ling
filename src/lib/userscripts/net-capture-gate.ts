// 网络录制 · per-host 门禁（隐私边界的第一层）。
//
// 录制是**默认关、按站点显式开**：这里维护「用户已同意录制的 host 集合」，
// 存扩展自有 kv（duoling-app）——它有固定键、写频极低，与 netlog 的观测数据分属两类。
//
// 注册侧消费：engine.syncNetRecorder 读本集合 → 只对这些 host 注册捕获件/转发件
// （见 engine.ts）。门禁在注册层生效，不在采集时过滤 —— 未授权的 host 页面里
// 根本没有录制代码，这是比「采了再丢」更硬的保证。
//
// 与 cookie-gate.ts 的分工：cookie 门在 SW 请求链路逐次校验（url 维度）；
// 这里在注册链路按 host 生效（注入维度），两者都只比 scheme/host，path 不参与。

import * as appDb from '@/lib/app-db'
import { normalizeHost } from './net-record-protocol'

/** kv 键：已同意录制的 host 列表（string[]，小写裸主机名，不含 scheme/端口/path） */
const NET_CAPTURE_HOSTS_KEY = 'netCaptureHosts'

/** 已同意录制的 host 集合（去重、已归一；存储缺失 / 脏数据一律收敛为空数组） */
export async function getNetCaptureHosts(): Promise<string[]> {
  let stored: unknown
  try {
    stored = await appDb.get<unknown>(NET_CAPTURE_HOSTS_KEY)
  } catch {
    return []
  }
  if (!Array.isArray(stored)) return []
  const out: string[] = []
  for (const item of stored) {
    const h = normalizeHost(String(item))
    if (h && !out.includes(h)) out.push(h)
  }
  return out
}

/** 整体覆写集合（内部入口；外部走 enable / disable），返回归一后的结果 */
export async function setNetCaptureHosts(hosts: string[]): Promise<string[]> {
  const next: string[] = []
  for (const item of hosts) {
    const h = normalizeHost(String(item))
    if (h && !next.includes(h)) next.push(h)
  }
  await appDb.set(NET_CAPTURE_HOSTS_KEY, next)
  return next
}

/** 开启某 host 的录制（同意卡的落点）。返回新的集合（供注册同步 / UI 刷新） */
export async function enableNetCapture(host: string): Promise<string[]> {
  const h = normalizeHost(host)
  if (!h) throw new Error(`无效的站点：${host}`)
  const cur = await getNetCaptureHosts()
  if (cur.includes(h)) return cur
  return setNetCaptureHosts([...cur, h])
}

/** 关闭某 host 的录制（可随时关）。返回新的集合；记录的清理由调用方决定是否连带 purge */
export async function disableNetCapture(host: string): Promise<string[]> {
  const h = normalizeHost(host)
  const cur = await getNetCaptureHosts()
  if (!cur.includes(h)) return cur
  return setNetCaptureHosts(cur.filter((x) => x !== h))
}

/** 该 host 是否已开启录制 */
export async function isNetCaptureEnabled(host: string): Promise<boolean> {
  const h = normalizeHost(host)
  if (!h) return false
  return (await getNetCaptureHosts()).includes(h)
}
