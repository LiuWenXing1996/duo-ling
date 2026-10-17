// 标签页录制 · 共享协议常量与记录形状。
//
// **机制与种类分两层**（命名规则由此而来）：
//   · 机制层 `tab-record-*` —— 按页挂载、上行、落库。与「录什么」无关。
//   · 种类层 `net-*`       —— 具体录哪一类信号（怎么包 fetch / 怎么剥鉴权头 / 怎么压摘要）。
//     网络是当前唯一的一类；`window.console` 之类将来平行加，不改机制层。
//
// 本文件是**读侧（SW）与写侧（页面件）之间的唯一形状来源**，各消费方必须逐字节一致：
//   · 件包 recorder/net-probe.ts（net 种类件）—— 直接 import 它那一类的常量；
//   · runtime-db.ts / dl-bridge.ts（SW 落库 + 入站归一化）—— 直接 import。
// 上行信封不再在这里：录制系统脚本经脚本桥的 `__dlEvent` 信封上行（见 shared
// 的 api-contract.ts），本文件只管采样记录本身的形状。

/**
 * 接口采样落在 tab_events store 时的判别键：与标签页存续轴事件**同表**（见 ARCHITECTURE.md「存储」节），
 * 靠它把两类记录分开 —— 存续轴事件用 reload / url / recordOn / recordOff。
 *
 * 它同时是**上行事件里的种类判别键**：同一条录制通道上，`kind` 说这条载荷属于哪一类信号。
 *
 * 放这里而不是落库模块：它是**跨读写两端的形状约定**（写侧打标、读侧据它分流），
 * 与 normalizeNetCapture 之于入站载荷同理。
 */
export const NET_TAB_KIND = 'net'

/** 请求体 / 响应体采样上限（字符数）——采样只用于给 AI 看结构，不是全量留档 */
export const NET_BODY_LIMIT = 2048

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

/**
 * URL query / fragment 里值的脱敏阈值：超过即替换占位符。
 * 短值是业务参数（`page=1` / `tab=top` / `page_size=10`），长值多是 id、签名或编码后的凭据。
 */
export const NET_QUERY_VALUE_MAX = 24

/**
 * 键名命中即脱敏。词边界匹配（`^` / `_` / `-` 或结尾），故 `keyword`、`search` 不会被误伤，
 * 而 `access_token` / `x-api-key` / `apiKey`（经驼峰拆分）会命中。
 */
export const NET_SENSITIVE_PARAM =
  /(^|_|-)(token|secret|key|sign|signature|sig|auth|access|code|password|passwd|pwd|session|sid|cid|uid|vid|gid|did)($|_|-)/

/** 脱敏后的占位值（ASCII，避免 URL 编码把占位符自己也编码掉） */
export const NET_MASK = '***'

/**
 * 一次接口采样的记录体（落 duoling-runtime 的 tab_events store，判别键 kind = NET_TAB_KIND。
 * id 为自增主键，写侧不填）。
 *
 * 归属：**只认 tabSessionId**（标签页存续行）。录制按标签页划分，不按站点 ——
 * 同一标签页导航到哪个 host 都记在同一行下，故记录里没有 host 字段。
 * 采样上的 host 若有需要，由读侧从 url 现推（纯展示）。
 */
export interface NetCaptureRecord {
  /** 自增主键（IndexedDB autoIncrement 生成） */
  id?: number
  /**
   * 归属的标签页存续行（由 SW 按 sender.tab.id 查出后给定，载荷不携带）。
   * 缺省 = 归属不明的记录，按页读不到它。
   */
  tabSessionId?: string
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

/** 去鉴权：再剥一遍（种类件已剥过，这里是 SW 侧的防线——消息源不可信） */
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

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** 驼峰拆成连字符，让 `apiKey` 也能被词边界正则命中（`keyword` 仍不命中） */
function splitCamel(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

function shouldMaskParam(name: string, value: string): boolean {
  return NET_SENSITIVE_PARAM.test(splitCamel(name)) || value.length > NET_QUERY_VALUE_MAX
}

/** 对 `k=v&k=v` 形态的片段逐对判定；键名一律保留（AI 要看出参数存在与否），只换值 */
function maskPairList(body: string): string {
  return body
    .split('&')
    .map((pair) => {
      const i = pair.indexOf('=')
      if (i <= 0) return pair
      const name = pair.slice(0, i)
      if (!shouldMaskParam(name, safeDecode(pair.slice(i + 1)))) return pair
      return `${name}=${NET_MASK}`
    })
    .join('&')
}

/**
 * 脱敏 URL 里的凭据：query 与 fragment 的值命中规则即换成 `***`。
 *
 * 补 `stripAuthHeaders` 留下的口子——只剥头挡不住把凭据放 URL 的站点
 * （`?access_token=…` / `?code=…` / `?sign=…` / OAuth implicit 的 `#access_token=…`），
 * 这类 URL 会连标识一起落库并进模型上下文。
 *
 * 键名保留、只换值：AI 判断「这个端点带哪些参数」不受影响，只是拿不到具体值。
 * fragment 只在形如 `k=v&k=v` 时处理——`#/route` 这种路由形态原样放行。
 */
export function stripUrlSecrets(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw // 非法 URL 原样返回：净化不该改变形状
  }
  const oldQuery = u.search
  const oldHash = u.hash
  const newQuery = oldQuery.length > 1 ? `?${maskPairList(oldQuery.slice(1))}` : oldQuery
  const newHash = oldHash.includes('=') ? `#${maskPairList(oldHash.slice(1))}` : oldHash
  if (newQuery === oldQuery && newHash === oldHash) return raw
  return u.origin + u.pathname + newQuery + newHash
}

/**
 * 入站归一化：把录制系统脚本送来的未知载荷收窄成 NetCaptureRecord（非法即 null，静默丢弃）。
 * 消息经过页面世界与多次结构化克隆，SW 不能信其形状——
 * 所有字段白名单化、类型强转、长度封顶、鉴权头再剥、URL 凭据再脱敏。
 *
 * tabSessionId 由调用方（SW）给定而非载荷携带：它要按 sender.tab.id 查出来，
 * 载荷里那一段来自页面世界，认了就等于让页面自己声明归属。
 */
export function normalizeNetCapture(recordRaw: unknown, tabSessionId?: string): NetCaptureRecord | null {
  if (!recordRaw || typeof recordRaw !== 'object') return null
  const c = recordRaw as Record<string, unknown>
  const type = c.type === 'xhr' ? 'xhr' : c.type === 'fetch' ? 'fetch' : null
  if (!type) return null
  const url = str(c.url)
  if (!url) return null
  return {
    ...(tabSessionId ? { tabSessionId } : {}),
    type,
    url: stripUrlSecrets(url).slice(0, 4096),
    method: (str(c.method) || 'GET').toUpperCase(),
    reqHeaders: stripAuthHeaders(headerDict(c.reqHeaders)),
    reqBody: capBody(c.reqBody),
    status: typeof c.status === 'number' && Number.isFinite(c.status) ? Math.trunc(c.status) : 0,
    respHeaders: stripAuthHeaders(headerDict(c.respHeaders)),
    respBody: capBody(c.respBody),
    t: typeof c.t === 'number' && Number.isFinite(c.t) ? Math.trunc(c.t) : Date.now(),
  }
}
