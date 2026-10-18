// GM_xmlhttpRequest 的后台实现（fetch 域）：SW 内特权请求，豁免 CORS。
// 与旧 GM 版不同：非 2xx 不抛错——HTTP 状态属于正常响应内容，由 FetchPayload.ok 承载。
//
// forbidden header 覆写（DNR session 规则）、redirect / timeout / 流式进度的机制与口径
// 见 ARCHITECTURE.md「脚本注入」节的 DNR 条目。覆写请求挂规则期间对该 host
// 独占（写者），纯请求共享（读者），读写锁在 dl-fetch-priv.ts。
//
// 在飞请求表只活在请求飞行期间；`abortFetch` 是它唯一的对外出口（服务 fetch.abort 命令），
// webRequest 观测与规则孤儿对账的挂载收在 `mountFetchObservation`（init 时调用一次）。
import { base64ToBytes, bytesToBase64, errorText } from '@duoling/shared'
import type { FetchFormBody, FetchInit, FetchPayload } from '@duoling/shared'
import {
  handleObservation,
  hostLock,
  mintRuleId,
  registerManualWaiter,
  splitHeaders,
  sweepOrphanRules,
} from '../dl-fetch-priv'
import { ApiError } from './api-error'

/**
 * 在飞行的特权请求：`requestId` → AbortController。
 *
 * 服务 `GM_xmlhttpRequest` 返回句柄的 `abort()`（`fetch.abort` 命令）——桥是请求-响应模型，
 * SW 无法反向控制一次已经发出的 fetch，故由本表把「包装层 mint 的 requestId」与 SW 侧控制器对上。
 * 请求结束（含超时 / 异常）即摘除，表只活在请求飞行期间。
 */
const inFlightFetches = new Map<string, AbortController>()

/** 判定请求体是否为包装侧生成的二进制信封（非此形状的对象一律拒绝，不静默吞） */
function isBinaryBody(v: unknown): v is { __dlBinaryBody: true; base64: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { __dlBinaryBody?: unknown }).__dlBinaryBody === true &&
    typeof (v as { base64?: unknown }).base64 === 'string'
  )
}

/** 判定请求体是否为包装侧生成的 FormData 信封 */
function isFormBody(v: unknown): v is { __dlFormData: true; fields: Array<{ name: string; value?: string; base64?: string; type?: string; filename?: string }> } {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { __dlFormData?: unknown }).__dlFormData === true &&
    Array.isArray((v as { fields?: unknown }).fields)
  )
}

/**
 * 把 FormData 信封重建为真正的 FormData：二进制字段（base64）还原为 Blob（带 type/filename），
 * 浏览器据此自动生成 multipart boundary。调用方务必不要手写 content-type——这里强制剔除并 warning，
 * 否则手设的 content-type 会覆盖 boundary，服务器必 400。
 */
function rebuildFormData(body: FetchFormBody): FormData {
  const fd = new FormData()
  for (const f of body.fields) {
    if (typeof f.value === 'string') {
      fd.append(f.name, f.value)
    } else if (typeof f.base64 === 'string') {
      const bytes = base64ToBytes(f.base64)
      const blob = new Blob([bytes], { type: f.type || 'application/octet-stream' })
      if (f.filename) fd.append(f.name, blob, f.filename)
      else fd.append(f.name, blob)
    }
  }
  return fd
}

/**
 * 读响应体；`onProgress` 存在时改成**流式读 + 边读边推进度**（读完照样拼成完整字节，返回路径不变）。
 *
 * 只有显式要进度的请求走这条路（`FetchInit.wantProgress`），其余仍是 `resp.arrayBuffer()` /
 * `resp.text()` —— 零行为变化。节流按「≥64KB 或 ≥50ms」：响应块可能很密（大文件几千块），
 * 逐块推会把 Port 打满，而进度条不需要那个粒度。
 */
async function readBodyStreaming(
  resp: Response,
  onProgress: (loaded: number, total: number | null) => void,
): Promise<ArrayBuffer> {
  const reader = resp.body?.getReader()
  if (!reader) return await resp.arrayBuffer() // 无流（罕见）：退化，仍给完整体
  const header = resp.headers.get('content-length')
  const parsed = header == null ? Number.NaN : Number(header)
  const total = Number.isFinite(parsed) && parsed >= 0 ? parsed : null

  const chunks: Uint8Array[] = []
  let loaded = 0
  let pushedAt = 0
  let pushedBytes = 0
  let frames = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    loaded += value.byteLength
    const now = Date.now()
    if (loaded - pushedBytes >= 65536 || now - pushedAt >= 50) {
      pushedAt = now
      pushedBytes = loaded
      frames++
      onProgress(loaded, total)
    }
  }
  // 收尾一帧：让进度走到头（有 content-length 时脚本才算得出 100%）
  frames++
  onProgress(loaded, total)
  // 诊断（debug 级）：这条**没出现**就说明压根没走流式那条路 —— 「收到 0 帧」的排查靠它分叉
  console.debug(`[duoling:dl] 流式读完成：${frames} 帧 / ${loaded} 字节 / total=${total}`)

  const out = new Uint8Array(loaded)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out.buffer // 新分配、offset 0、长度正好 —— 直接交出底层缓冲
}

/**
 * GM_xmlhttpRequest 的后台实现：SW 内特权请求，豁免 CORS（机制口径见文件头）。
 */
export async function doFetch(
  url: string,
  init?: FetchInit,
  progress?: (loaded: number, total: number | null) => void,
): Promise<FetchPayload> {
  const redirect = init?.redirect ?? 'follow'
  if (redirect !== 'follow' && redirect !== 'manual' && redirect !== 'error') {
    throw new ApiError('INVALID_ARG', `GM_xmlhttpRequest：redirect 仅支持 follow / manual / error，收到「${String(redirect)}」`)
  }
  let host: string
  let hostname: string
  try {
    const parsed = new URL(url)
    host = parsed.host
    hostname = parsed.hostname
  } catch {
    throw new ApiError('INVALID_ARG', `GM_xmlhttpRequest：URL 无法解析：${url}`)
  }

  // header 拆两路：禁设头走 DNR 规则，其余走原生 Headers
  const { native, dnrOps } = splitHeaders(init?.headers)
  const method = (init?.method || 'GET').toUpperCase()
  const headers = new Headers()
  for (const [k, v] of Object.entries(native)) headers.set(k, v)
  const req: RequestInit = { method, headers }
  if (init?.body != null && method !== 'GET' && method !== 'HEAD') {
    if (typeof init.body === 'string') {
      req.body = init.body
    } else if (isBinaryBody(init.body)) {
      req.body = base64ToBytes(init.body.base64)
    } else if (isFormBody(init.body)) {
      // FormData：重建后让浏览器自动设 multipart boundary——手写 content-type 会破坏它
      if (headers.has('content-type')) {
        console.warn('[duoling:dl] fetch FormData 请求含手写 content-type，已强制剔除（boundary 由浏览器生成）')
        headers.delete('content-type')
      }
      req.body = rebuildFormData(init.body)
    } else {
      throw new ApiError('INVALID_ARG', 'GM_xmlhttpRequest：body 仅支持字符串 / Blob / FormData / ArrayBuffer / TypedArray / DataView')
    }
  }

  // host 级读写锁：覆写请求 = 写者（独占，规则挂起期间同 host 全部排队），纯请求 = 读者
  const lock = hostLock(host)
  const isWriter = dnrOps.length > 0
  if (isWriter) {
    await lock.acquireWriter()
  } else {
    await lock.acquireReader()
  }

  const timeout = init?.timeout
  const controller = new AbortController()
  // 登记在飞请求，供 `fetch.abort` 真中止（包装层 mint 的 requestId；不传即不可中止）
  const requestId = init?.requestId
  if (requestId) inFlightFetches.set(requestId, controller)
  let timer: ReturnType<typeof setTimeout> | undefined
  if (timeout && timeout > 0) {
    timer = setTimeout(
      () => controller.abort(new ApiError('BRIDGE_TIMEOUT', `GM_xmlhttpRequest 请求超时（${timeout}ms）：${url}`)),
      timeout,
    )
  }

  let ruleId: number | undefined
  // manual：观测等待者必须先于 fetch 登记（观测事件在 fetch 进行中到达）；
  // 声明在 try 外，finally 的 cancel 才够得着
  const manualWaiter = redirect === 'manual' ? registerManualWaiter(url) : undefined
  try {
    if (isWriter) {
      ruleId = mintRuleId()
      const dnr = chrome.declarativeNetRequest
      if (!dnr?.updateSessionRules) {
        throw new ApiError('NOT_AVAILABLE', 'GM_xmlhttpRequest：请求头覆写能力不可用')
      }
      try {
        await dnr.updateSessionRules({
          removeRuleIds: [ruleId],
          addRules: [
            {
              id: ruleId,
              priority: 1,
              action: { type: 'modifyHeaders', requestHeaders: dnrOps },
              // resourceTypes 省略：默认匹配除 main_frame 外全部类型，覆盖 SW fetch 的
              // xmlhttprequest（探针实测）且不引入对类型枚举的硬依赖
              // 按域匹配用 hostname：DNR 的 requestDomains / initiatorDomains 只认主机名，
              // 传带端口的 host 会静默失配（规则挂上但不命中任何请求）
              condition: { requestDomains: [hostname], initiatorDomains: [chrome.runtime.id] },
            },
          ],
        })
      } catch (e) {
        const msg = errorText(e)
        throw new ApiError('INTERNAL', `GM_xmlhttpRequest：设置请求头覆写规则失败：${msg}`)
      }
    }

    // manual：等待者已登记（见 try 前），这里直接发请求
    const resp = await fetch(url, {
      credentials: 'omit',
      ...req,
      redirect: redirect === 'follow' ? undefined : redirect,
      signal: controller.signal,
    })

    if (manualWaiter && resp.type === 'opaqueredirect') {
      // opaqueredirect 无任何可读信息，等 webRequest 观测补齐 3xx 状态与响应头。
      // 防御两路：abort（超时）立即打断等待；观测迟迟不来（理论不应发生）兜底报错不挂死。
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(controller.signal.reason)
        if (controller.signal.aborted) onAbort()
        else controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      const grace = new Promise<null>((r) => setTimeout(() => r(null), 5000))
      const obs = await Promise.race([manualWaiter.promise, grace, aborted])
      if (!obs) {
        throw new ApiError('INTERNAL', `GM_xmlhttpRequest：未能观测到 3xx 响应（webRequest 未见该请求）：${url}`)
      }
      const responseType = init?.responseType === 'arraybuffer' ? 'arraybuffer' : 'text'
      return {
        ok: obs.statusCode >= 200 && obs.statusCode < 300,
        status: obs.statusCode,
        statusText: '', // webRequest 不提供 statusText
        headers: obs.headers,
        url, // manual 语义：请求 URL，非 Location
        body: '', // 3xx 无响应体语义
        responseType,
      }
    }

    const responseHeaders: Record<string, string> = {}
    resp.headers.forEach((v, k) => (responseHeaders[k] = v))
    const responseType = init?.responseType === 'arraybuffer' ? 'arraybuffer' : 'text'
    // 要了进度 → 流式读（边读边推）；否则整体读。两条路拿到的都是**完整字节**，只是前者会推进度帧。
    const bytes = progress ? await readBodyStreaming(resp, progress) : undefined
    // 二进制无法结构化克隆过桥，转 base64（包装侧 arrayBuffer() 解码）
    const body =
      responseType === 'arraybuffer'
        ? bytesToBase64(bytes ?? (await resp.arrayBuffer()))
        : bytes
          ? new TextDecoder().decode(bytes)
          : await resp.text()
    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      headers: responseHeaders,
      url: resp.url, // 跟随重定向后的最终 URL
      body,
      responseType,
    }
  } catch (e: unknown) {
    // 超时中止：若 abort 携带的 ApiError 原样抛出就直接用，否则兜一层（防御浏览器包装）
    if (controller.signal.aborted) {
      throw e instanceof ApiError
        ? e
        : new ApiError('BRIDGE_TIMEOUT', `GM_xmlhttpRequest 请求超时（${timeout ?? 0}ms）：${url}`)
    }
    throw e
  } finally {
    if (requestId) inFlightFetches.delete(requestId)
    if (timer) clearTimeout(timer)
    manualWaiter?.cancel()
    // 用后即撤（主路径）：settle 即撤规则（先撤再放锁，避免下一条覆写规则与残留叠加），
    // 幂等；撤失败由启动对账 + 浏览器重启兜底
    if (ruleId !== undefined) {
      try {
        await chrome.declarativeNetRequest?.updateSessionRules?.({ removeRuleIds: [ruleId] })
      } catch {
        // 静默：生命周期有第二、三层兜底
      }
    }
    if (isWriter) lock.releaseWriter()
    else lock.releaseReader()
  }
}

/**
 * 真中止在飞请求（服务 `fetch.abort` 命令）：按 requestId 查表拿控制器。
 * 查不到 = 请求已结束（或从未存在），幂等处理不报错（连续 abort 是合法调用）。
 */
export function abortFetch(requestId: string): void {
  const controller = inFlightFetches.get(requestId)
  if (controller && !controller.signal.aborted) {
    controller.abort(new ApiError('INTERNAL', 'GM_xmlhttpRequest：请求已被脚本中止'))
  }
}

/**
 * 挂观察型 webRequest + 规则孤儿对账（init 时调用一次）。
 *
 * 观察型 webRequest 是 redirect:'manual' 的 3xx 响应读取通道（SW fetch 只拿得到
 * opaqueredirect，探针已证实 webRequest 能看到自家 SW fetch）。顶层注册（MV3 要求）；
 * 无 manual 等待者时立即返回，浏览器全部流量都会路过这里，分发入口必须廉价。
 * 对账是「用后即撤」的第二层：清掉上次崩溃残留的自有区间 session 规则。
 */
export function mountFetchObservation(): void {
  chrome.webRequest?.onHeadersReceived?.addListener(
    handleObservation,
    { urls: ['*://*/*'] },
    ['responseHeaders', 'extraHeaders'],
  )
  void sweepOrphanRules().catch(() => {})
}
