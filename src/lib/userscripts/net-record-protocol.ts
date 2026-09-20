// 网络录制（dl-recorder）共享协议常量与记录形状。
//
// 三个消费方必须逐字节一致，故集中在这里：
//   · net-recorder.ts（MAIN 世界捕获件）—— 字符串模板，插值 constants；
//   · net-forwarder.ts（USER_SCRIPT 转发件）—— 字符串模板，插值 TAG；
//   · netlog-db.ts / dl-bridge.ts（SW 落库 + 入站归一化）—— 直接 import。
//
// 与 page-protocol.ts 同款：模板源码无法 import，只能靠常量插值保持一致。

/** 消息信封标记：MAIN 捕获件 postMessage 与转发件 → SW 的 sendMessage 都用它 */
export const NET_CAPTURE_TAG = '__dlNetCapture'

/** 请求体 / 响应体采样上限（字符数）——采样只用于给 AI 看结构，不是全量留档 */
export const NET_BODY_LIMIT = 2048

/** 每 host 环形保留条数（超限删最旧）——写侧 netlog-db 裁剪，隐私与体积双控 */
export const NET_HOST_RING_LIMIT = 200

/**
 * 剥离的鉴权头（小写名，精确匹配）。请求侧与响应侧同一份：
 * 页面 JS 本就读不到 HttpOnly Cookie，但能读到 document.cookie / 自设的 Authorization，
 * 这些一旦进库就会随 AI 上下文外泄，故两向都不留。
 */
export const NET_AUTH_HEADER_NAMES = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
] as const

/** 采集记录（落 duoling-netlog captures store 的形状；id 为自增主键，写侧不填） */
export interface NetCaptureRecord {
  /** 自增主键（IndexedDB autoIncrement 生成） */
  id?: number
  /** 采集发生的页面 host（location.hostname，环形分区键，也是 by_host 索引值） */
  host: string
  /** 请求方式来源 */
  type: 'fetch' | 'xhr'
  url: string
  method: string
  /** 已剥离鉴权头的请求头 */
  reqHeaders: Record<string, string>
  /** 请求体采样（≤NET_BODY_LIMIT；二进制为 '[binary]'；无体为 null） */
  reqBody: string | null
  /** 响应状态码（请求失败 / 无响应为 0） */
  status: number
  /** 已剥离鉴权头的响应头 */
  respHeaders: Record<string, string>
  /** 响应体结构摘要（≤NET_BODY_LIMIT；二进制为 '[binary]'；无体为 null） */
  respBody: string | null
  /** 采集时刻（ms） */
  t: number
}

/** 采集载荷：转发件负责补 host，捕获件只产这些字段 */
export type NetCapturePayload = Omit<NetCaptureRecord, 'id' | 'host'>

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 把未知值收窄成字符串字典（只保留字符串值，键强制小写） */
function headerDict(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k.toLowerCase()] = val
  }
  return out
}

/** 去鉴权：再剥一遍（捕获件已剥过，这里是 SW 侧的防线——消息源不可信） */
export function stripAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const banned = new Set<string>(NET_AUTH_HEADER_NAMES)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (!banned.has(k.toLowerCase())) out[k] = v
  }
  return out
}

function capBody(v: unknown): string | null {
  if (typeof v !== 'string') return null
  return v.length > NET_BODY_LIMIT ? v.slice(0, NET_BODY_LIMIT) : v
}

/**
 * 入站归一化：把转发件送来的未知载荷收窄成 NetCaptureRecord（非法即 null，静默丢弃）。
 * 消息经过 MAIN 世界（页面可伪造 postMessage）与两次结构化克隆，SW 不能信其形状——
 * 所有字段白名单化、类型强转、长度封顶、鉴权头再剥。
 */
export function normalizeCapture(hostRaw: unknown, captureRaw: unknown): NetCaptureRecord | null {
  const host = str(hostRaw).toLowerCase()
  if (!host) return null
  if (!captureRaw || typeof captureRaw !== 'object') return null
  const c = captureRaw as Record<string, unknown>
  const type = c.type === 'xhr' ? 'xhr' : c.type === 'fetch' ? 'fetch' : null
  if (!type) return null
  const url = str(c.url)
  if (!url) return null
  return {
    host,
    type,
    url: url.slice(0, 4096),
    method: (str(c.method) || 'GET').toUpperCase(),
    reqHeaders: stripAuthHeaders(headerDict(c.reqHeaders)),
    reqBody: capBody(c.reqBody),
    status: typeof c.status === 'number' && Number.isFinite(c.status) ? Math.trunc(c.status) : 0,
    respHeaders: stripAuthHeaders(headerDict(c.respHeaders)),
    respBody: capBody(c.respBody),
    t: typeof c.t === 'number' && Number.isFinite(c.t) ? Math.trunc(c.t) : Date.now(),
  }
}
