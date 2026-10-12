// 网络录制（dl-recorder）共享协议常量与记录形状。
//
// 三个消费方必须逐字节一致，故集中在这里：
//   · net-recorder.ts（MAIN 世界捕获件）—— 字符串模板，插值 constants；
//   · net-forwarder.ts（USER_SCRIPT 转发件）—— 字符串模板，插值 TAG；
//   · runtime-db.ts / dl-bridge.ts（SW 落库 + 入站归一化）—— 直接 import。
//
// 与 bridge-protocol.ts 同款：模板源码无法 import，只能靠常量插值保持一致。

/** 消息信封标记：MAIN 捕获件 postMessage 与转发件 → SW 的 sendMessage 都用它 */
export const NET_CAPTURE_TAG = '__dlNetCapture'

/**
 * 接口采样落在 tab_events store 时的判别键：与标签页存续轴事件**同表**（见 runtime-db 的文件头），
 * 靠它把两类记录分开 —— 存续轴事件用 reload / url / recordOn / recordOff。
 *
 * 放这里而不是落库模块：它是**跨读写两端的形状约定**（写侧打标、读侧据它分流），
 * 与 normalizeCapture 之于入站载荷同理。
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
 * 一次接口录制会话：从用户在某标签页点「开启录制」起，到该标签页关闭 / 主动停止止。
 *
 * 门禁的粒度就是它 —— 录制按标签页划分，同站点的另一个标签页要录得各自开一次。
 * 标签页关掉即结束会话，但已录采样不随之清除：它们落在 tab_events 上，按页读时与这一页的
 * 刷新 / 记录开关同轴展示，故会话本身不必再另存一份归档。
 *
 * tabId 是会话的**实时判据**（入站按 sender.tab.id 认领），但浏览器会复用 tabId，
 * 故它不是身份：采样归属一律用 id 与 tabSessionId，tabId 只用于「此刻这条消息来自哪个会话」。
 */
export interface NetRecordSession {
  /** 会话 id（每条采样带着它，故必须是稳定、不可复用的字符串） */
  id: string
  /** 录制所在的标签页（仅实时判据用，不作身份） */
  tabId: number
  /**
   * 这次录制归属的标签页存续行（见 TabSessionRecord）。
   *
   * 与 tabId 的分工：tabId 只答「此刻这条消息来自哪个标签页」，它答「把这段录制挂到哪一页」。
   * 两者不是一回事 —— tabId 会被浏览器复用、重启后重排，故跨会话的归属只能认它。
   * 录制与活动记录由同一个开关触发后必填；合并前录下的老会话没有，读侧按「未归属」处理。
   */
  tabSessionId?: string
  /** 录制所在的站点（与采样同口径的归一 host） */
  host: string
  /** 开启那一刻页面的地址与标题：会话随门禁消亡后，凭它认出录的是哪个页面（采样上不带标题） */
  url: string
  title: string
  startedAt: number
  /** 结束时刻（会话结束 / 启动对账清出时填；进行中的会话没有） */
  endedAt?: number
}

/** 采集采样（落 duoling-runtime 的 tab_events store，判别键 kind = NET_TAB_KIND；id 为自增主键，写侧不填） */
export interface NetCaptureRecord {
  /** 自增主键（IndexedDB autoIncrement 生成） */
  id?: number
  /** 采集发生的页面 host（location.hostname，也是 by_host 索引值；存续轴事件没有它） */
  host: string
  /** 产生这条采样的录制会话 id。会话结束后采样仍留着，凭它把采样归到某次录制 */
  sessionId: string
  /** 归属的标签页存续行（由会话透传，见 NetRecordSession.tabSessionId）；老采样缺省，按未归属处理 */
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

/**
 * 采集载荷：捕获件只产这些字段。
 * host 由转发件补（它知道自己的 location），sessionId 由 SW 补（只有它能判消息来自哪个标签页）。
 */
export type NetCapturePayload = Omit<NetCaptureRecord, 'id' | 'host' | 'sessionId' | 'tabSessionId'>

/**
 * 把一个 host 归一化成「小写裸主机名」；非法返回空串。
 * 容忍传入完整 URL / 带端口 / 大写——AI 工具与同意卡拿到的可能是任意形态。
 *
 * 放这里而不是门禁模块：归一化是**跨上下文的形状约定**（SW 门禁、engine 注册、
 * offscreen 侧工具都要判同一个 host），三方必须用同一份实现，否则
 * 「工具说已开、门禁说不认识」这类静默错配会出现。
 */
export function normalizeHost(input: string): string {
  let h = String(input ?? '').trim().toLowerCase()
  if (!h) return ''
  if (h.includes('://')) {
    try {
      h = new URL(h).hostname.toLowerCase()
    } catch {
      return ''
    }
  } else {
    const m = /^([^/:]+)(?::\d+)?$/.exec(h)
    h = m ? m[1] : h
  }
  h = h.replace(/^\.+|\.+$/g, '')
  // 允许 a-z0-9 . - _（内网主机名常见下划线）；拒绝一切可能越界到 pattern 的字符
  if (!/^[a-z0-9._-]+$/.test(h)) return ''
  return h
}

/** host → match pattern：`*://` 同时覆盖 http / https（match pattern 里端口不参与匹配） */
export function hostToMatchPattern(host: string): string {
  return `*://${host}/*`
}

/**
 * 从页面 URL 里取归一化 host（AI 工具据当前页面推断目标站点用）；取不到返回空串。
 * 只认 http/https——录制件注册的 pattern 就是 `*://`，其余协议（chrome: / file: 等）
 * 本来也注入不了，早退回空串可以省掉一次无谓的门禁查询。
 */
export function hostFromUrl(url: string | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return normalizeHost(u.hostname)
  } catch {
    return ''
  }
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
 * 入站归一化：把转发件送来的未知载荷收窄成 NetCaptureRecord（非法即 null，静默丢弃）。
 * 消息经过 MAIN 世界（页面可伪造 postMessage）与两次结构化克隆，SW 不能信其形状——
 * 所有字段白名单化、类型强转、长度封顶、鉴权头再剥、URL 凭据再脱敏。
 *
 * sessionId 与 tabSessionId 都由调用方（SW）给定而非载荷携带：它们要按 sender.tab.id 查出来，
 * 载荷里那一段来自页面世界，认了就等于让页面自己声明归属。
 */
export function normalizeCapture(
  hostRaw: unknown,
  captureRaw: unknown,
  sessionId: string,
  tabSessionId?: string,
): NetCaptureRecord | null {
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
    sessionId,
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
