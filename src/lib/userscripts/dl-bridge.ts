// GM 后台桥（协议契约 src/lib/userscripts/api-contract.ts）。
//
// USER_SCRIPT 世界的 GM 包装（gm-wrapper.ts 注入的那份源码）经 chrome.runtime.sendMessage 发来的消息，
// 因世界已 configureWorld({messaging:true})，被路由到本文件的 runtime.onUserScriptMessage（而非通用 onMessage）。
//
// 消息分流（契约定义；信封名保持 __dl 前缀）：
//   { __dl: true, uuid, req: ApiRequest }        —— 请求-响应，按 req.c 强类型分发（穷尽性检查）
//   { __dlEvent: true, uuid, name, event: DlEvent } —— 单向错误上报，收进错误日志（runtime 库）
//   { __dlRunStart: true, uuid, name, runId }    —— 运行标识广播：交侧边栏监控按 tab 登记
//
// 安全性：消息来源天然是「不可信用户脚本」，故校验 sender.userScript.scriptId 与消息里的 uuid 一致，
// 防止伪造身份读写其它脚本的私有存储。background 的 SW 内 fetch 受 <all_urls> host 权限豁免 CORS，
// 这是 GM_xmlhttpRequest 免 CORS 的基础（Chrome 官方明文：内容脚本中的跨源请求始终按跨源处理）。
import type {
  ApiErrorCode,
  ApiRequest,
  ApiResponse,
  GmCookie,
  DlEvent,
  FetchFormBody,
  FetchInit,
  FetchPayload,
  Json,
} from './api-contract'
// Port 事件底座：控制面实现（菜单登记 / 键级与全量值订阅 / 通知归属 / URL 订阅）
import {
  registerScriptMenu,
  unregisterScriptMenu,
  attachScriptWatch,
  detachScriptWatch,
  attachValueWatch,
  detachValueWatch,
  mintNotification,
  attachUrlWatch,
  detachUrlWatch,
} from './dl-port'
// GM_cookie 域名门（安全边界：url 须落在该脚本自身 matches 内，只比 scheme+host）
import { checkCookieUrl } from './cookie-gate'
// 网络录制：转发件送来的采集载荷在 SW 侧白名单化后落 duoling-netlog
import { normalizeCapture } from './net-record-protocol'
import * as netlog from './netlog-db'
// 侧边栏页面脚本监控（运行时口径）：runstart 登记 + 错误实时推送（跨文档观察者，SW 按 tab 登记）
import { notePageError, noteRunStart } from './page-monitor'
import {
  getGMValue,
  setGMValue,
  deleteGMValue,
  listGMKeys,
  getAllGMValues,
  clearGMValues,
  appendUserScriptError,
  recordRunStart,
} from './store'
// offscreen 容器就绪（SW 侧模块；dl-bridge 与 background 同属 SW，不触及 offscreen 专有 runtime API）
import { ensureOffscreenReady } from '@/lib/offscreen'
// GM_getTab 标签页级存储后端（duoling-usdata 库，SW 独占写）
import * as usdata from './usdata-db'
// GM_xmlhttpRequest 特权增强：forbidden header 覆写（DNR session 规则）+ redirect:'manual'（webRequest 观测）
import {
  splitHeaders,
  hostLock,
  mintRuleId,
  sweepOrphanRules,
  registerManualWaiter,
  handleObservation,
} from './dl-fetch-priv'

/** 通知兜底图标（打包资源）。MV3 的 notifications.create 不接受 data: URL 图标
 * （报 "Unable to download all specified images."），必须用扩展内资源或 http(s) 图 */
const FALLBACK_ICON = 'notify-icon.png' // 相对扩展根，即 src/public/notify-icon.png

/**
 * 在飞行的特权请求：`requestId` → AbortController。
 *
 * 服务 `GM_xmlhttpRequest` 返回句柄的 `abort()`（`fetch.abort` 命令）——桥是请求-响应模型，
 * SW 无法反向控制一次已经发出的 fetch，故由本表把「包装层 mint 的 requestId」与 SW 侧控制器对上。
 * 请求结束（含超时 / 异常）即摘除，表只活在请求飞行期间。
 */
const inFlightFetches = new Map<string, AbortController>()

/** 带 ApiErrorCode 的错误：dispatch 抛出后由监听器写入响应信封的 code 字段 */
class ApiError extends Error {
  code: ApiErrorCode
  constructor(code: ApiErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** 把 ArrayBuffer 转 base64（分块避免大数组爆栈） */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[])
  }
  return btoa(binary)
}

/** 把 base64 解回二进制（fetch 二进制请求体信封的 SW 侧解码） */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const bytes = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

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
 * GM_xmlhttpRequest 的后台实现：SW 内特权请求，豁免 CORS。
 * 与旧 GM 版不同：非 2xx 不抛错——HTTP 状态属于正常响应内容，由 FetchPayload.ok 承载。
 *
 * forbidden header 覆写：Cookie/Referer/Origin 等（连同 User-Agent）由 DNR session 规则
 * 在发头前套上（fetch 规范对 Headers 里的禁设头是静默丢弃）。覆写请求挂规则期间对该 host
 * 独占（写者），纯请求共享（读者）——DNR 规则没有按请求的粒度，不互斥会把覆写头污染到
 * 同 host 的并发请求上。
 *
 * redirect：'manual' 时 3xx 响应经观察型 webRequest 读取（SW fetch 只拿得到 opaqueredirect）；
 * 'error' 交给 fetch 原生（遇 3xx 直接 reject，错误信息来自浏览器）。
 *
 * timeout：毫秒，0 / 不传不限。用 AbortController 在到点时中止请求（响应体读取同样受
 * 信号约束，慢响应读到一半也会被掐断）；中止后统一报 BRIDGE_TIMEOUT，不让脚本调用挂死。
 */
async function doFetch(url: string, init?: FetchInit): Promise<FetchPayload> {
  const redirect = init?.redirect ?? 'follow'
  if (redirect !== 'follow' && redirect !== 'manual' && redirect !== 'error') {
    throw new ApiError('INVALID_ARG', `GM_xmlhttpRequest：redirect 仅支持 follow / manual / error，收到「${String(redirect)}」`)
  }
  let host: string
  try {
    host = new URL(url).host
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
        throw new ApiError('NOT_AVAILABLE', 'GM_xmlhttpRequest：declarativeNetRequest 不可用')
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
              condition: { requestDomains: [host], initiatorDomains: [chrome.runtime.id] },
            },
          ],
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new ApiError('INTERNAL', `GM_xmlhttpRequest：挂载 header 覆写规则失败：${msg}`)
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
    // 二进制无法结构化克隆过桥，转 base64（包装侧 arrayBuffer() 解码）
    const body =
      responseType === 'arraybuffer' ? arrayBufferToBase64(await resp.arrayBuffer()) : await resp.text()
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

/** GM_download 的后台实现：抓成 dataUrl，包装侧用 a[download] 触发本地下载（避免新增 downloads 权限） */
async function doDownload(url: string, name: string): Promise<{ dataUrl: string; name: string }> {
  const resp = await fetch(url, { credentials: 'omit' })
  if (!resp.ok) throw new Error(`下载 ${url} 失败：${resp.status} ${resp.statusText}`)
  const buf = await resp.arrayBuffer()
  const mime = resp.headers.get('content-type') || 'application/octet-stream'
  return { dataUrl: `data:${mime};base64,${arrayBufferToBase64(buf)}`, name }
}

// ————————————————————— cookie（cookies 权限）—————————————————————

/**
 * 取 chrome.cookies，缺失即明确报错（扩展未声明 cookies 权限 / 旧产物）；不静默降级。
 */
function cookiesApi(): typeof chrome.cookies {
  const api = chrome.cookies
  if (!api || typeof api.get !== 'function') {
    throw new ApiError('NOT_AVAILABLE', 'cookie 能力不可用：扩展未声明 cookies 权限')
  }
  return api
}

/**
 * 过域名门（越域即拒）。**所有** cookie 命令都必须先走这里 —— 门在 SW 侧是唯一执行点，
 * 包装层传什么 url 都不可信。
 */
async function assertCookieScope(uuid: string, url: string): Promise<void> {
  const gate = await checkCookieUrl(uuid, url)
  if (!gate.ok) throw new ApiError(gate.code, gate.message)
}

/** chrome.cookies.Cookie → GmCookie（只取可跨桥 / 允许暴露的字段） */
function toGmCookie(c: chrome.cookies.Cookie): GmCookie {
  const out: GmCookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    session: c.session,
    hostOnly: c.hostOnly,
  }
  // session cookie 无 expirationDate（chrome 侧为 undefined），不写空字段
  if (typeof c.expirationDate === 'number') out.expirationDate = c.expirationDate
  return out
}

// —— 标签页级存储（对齐 GM_getTab 系列）：duoling-usdata 库的 tab store，
// 复合主键 [uuid, tabId]（原 chrome.storage 键空间 us:tab:<uuid>:<tabId>），
// 每脚本每 tab 一记录，避免多 tab 并发互相覆盖 ——

/** 读当前标签页对象 */
async function getTabValue(uuid: string, tabId: number): Promise<Json | undefined> {
  const v = await usdata.getTabValue(uuid, tabId)
  return v === undefined ? undefined : (v as Json)
}

/** 覆盖写当前标签页对象 */
async function saveTabValue(uuid: string, tabId: number, value: Json): Promise<void> {
  await usdata.putTabValue(uuid, tabId, value)
}

/** 全部标签页对象快照：键为 tabId 字符串（对齐 GM_getTabs）。仅本脚本自身 */
async function getAllTabValues(uuid: string): Promise<Record<string, Json>> {
  const all = await usdata.listTabValues(uuid)
  return all as Record<string, Json>
}

/** 删除某 tab 的全部 tab 存储键（tab 关闭清理） */
async function dropTabKeys(tabId: number): Promise<void> {
  await usdata.deleteTabsByTabId(tabId)
}

/** 启动时对账：清掉「记录存在但 tab 已不存在」的孤儿记录（兜浏览器崩溃 / SW 错过 onRemoved） */
async function reconcileOrphanTabKeys(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({})
    const alive = new Set(tabs.map((t) => t.id).filter((id): id is number => id != null))
    await usdata.pruneTabsNotIn(alive)
  } catch {
    // 对账失败不阻断链路
  }
}

/** 经 offscreen 写剪贴板（免用户手势；writeText / ClipboardItem 双轨）。超时即报，不挂死 */
async function writeClipboardViaOffscreen(text?: string, html?: string): Promise<void> {
  if (!text && !html) throw new ApiError('INVALID_ARG', 'GM_setClipboard：text 与 html 至少给一个')
  const ready = await ensureOffscreenReady()
  if (!ready) throw new ApiError('NOT_AVAILABLE', 'GM_setClipboard：offscreen 容器不可用，无法写剪贴板')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ApiError('BRIDGE_TIMEOUT', 'GM_setClipboard 写入超时（offscreen 2s 无响应）')),
      2000,
    )
    try {
      chrome.runtime.sendMessage({ kind: 'clipboard:write', text: text ?? null, html: html ?? null }, (resp: unknown) => {
        clearTimeout(timer)
        const err = chrome.runtime.lastError
        if (err) return reject(new ApiError('NOT_AVAILABLE', 'GM_setClipboard：' + err.message))
        const r = resp as { ok?: boolean; error?: string } | undefined
        if (!r || !r.ok) return reject(new ApiError('INTERNAL', r?.error || 'GM_setClipboard 写入失败'))
        resolve()
      })
    } catch (e) {
      clearTimeout(timer)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}
/** 按命令分发（已确认 __dl 标记与身份）。参数见 ApiRequest 契约注释 */
async function dispatch(uuid: string, req: ApiRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab?.id
  switch (req.c) {
    // 存储（键空间按脚本隔离）
    case 'store.get': {
      const v = await getGMValue(uuid, req.key)
      return v === undefined ? req.fallback : v
    }
    // connId 随写请求带上：推送侧据此把「本实例自己写的」帧标 remote=false（GM_addValueChangeListener 第 4 参）
    case 'store.set':
      await setGMValue(uuid, req.key, req.value, req.connId)
      return undefined
    case 'store.delete':
      await deleteGMValue(uuid, req.key, req.connId)
      return undefined
    case 'store.keys':
      return listGMKeys(uuid)
    // 全量快照：注入时的值预载（注册链路直接调 store.ts）与包装层 connect 后的校准共用
    case 'store.all':
      return getAllGMValues(uuid)
    case 'store.clear':
      await clearGMValues(uuid, req.connId)
      return undefined
    // 网络
    case 'fetch':
      return doFetch(req.url, req.init)
    case 'fetch.abort': {
      // 真中止：桥是请求-响应模型，SW 无法反向控制已发出的 fetch，故按 requestId 查表拿控制器。
      // 查不到 = 请求已结束（或从未存在），幂等处理不报错（连续 abort 是合法调用）。
      const controller = inFlightFetches.get(req.requestId)
      if (controller && !controller.signal.aborted) {
        controller.abort(new ApiError('INTERNAL', 'GM_xmlhttpRequest：请求已被脚本中止'))
      }
      return undefined
    }
    // 系统能力
    case 'notify': {
      // mint 通知 id 并登记归属：点击事件经 DL Port 回推（包装层按 id 挂 onClick）
      const id = mintNotification(uuid)
      await chrome.notifications.create(id, {
        type: 'basic',
        iconUrl: req.icon || FALLBACK_ICON,
        title: req.title || '哆灵用户脚本',
        message: req.message || '',
      })
      return { id }
    }
    case 'download':
      return doDownload(req.url, req.name || 'download')
    // 剪贴板：走 offscreen（免用户手势）+ 富文本（clipboardWrite 权限）
    case 'clipboard.write':
      await writeClipboardViaOffscreen(req.text, req.html)
      return undefined
    // 标签页级存储（对齐 GM_getTab 系列）
    case 'tab.get': {
      if (tabId == null) throw new ApiError('INVALID_ARG', 'GM_getTab 需要标签页上下文（sender.tab 缺失）')
      return getTabValue(uuid, tabId)
    }
    case 'tab.save': {
      if (tabId == null) throw new ApiError('INVALID_ARG', 'GM_getTab 需要标签页上下文（sender.tab 缺失）')
      await saveTabValue(uuid, tabId, req.value)
      return undefined
    }
    case 'tab.all':
      return getAllTabValues(uuid)
    // URL 变化订阅（SPA 路由感知）：控制面走请求-响应，归属定位同 store.watch（connId）
    case 'url.watch': {
      if (!attachUrlWatch(uuid, req.connId)) {
        throw new ApiError('INTERNAL', 'DL Port 未就绪，订阅未生效（请重试）')
      }
      return undefined
    }
    case 'url.unwatch':
      detachUrlWatch(uuid, req.connId)
      return undefined
    case 'tabs.open': {
      const tab = await chrome.tabs.create({ url: req.url, active: req.active !== false })
      if (tab?.id == null) throw new ApiError('INTERNAL', 'tabs.open 未返回 tabId')
      return tab.id
    }
    case 'tabs.close':
      await chrome.tabs.remove(req.tabId)
      return undefined
    case 'tabs.focus': {
      // 激活标签页 + 聚焦其所在窗口（跨窗口 focus 语义才完整）；窗口聚焦失败不拖垮整体
      const tab = await chrome.tabs.update(req.tabId, { active: true })
      if (tab?.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
      }
      return undefined
    }
    // cookie（cookies 权限）：先过域名门，再碰 chrome.cookies —— 顺序不可倒（门是唯一安全边界）
    case 'cookie.get': {
      await assertCookieScope(uuid, req.url)
      const api = cookiesApi()
      if (req.name != null && req.name !== '') {
        const one = await api.get({ url: req.url, name: req.name })
        return one ? [toGmCookie(one)] : []
      }
      const all = await api.getAll({ url: req.url })
      return all.map(toGmCookie)
    }
    case 'cookie.set': {
      await assertCookieScope(uuid, req.url)
      if (typeof req.name !== 'string' || !req.name) {
        throw new ApiError('INVALID_ARG', 'GM_cookie.set：name 必填')
      }
      if (typeof req.value !== 'string') {
        throw new ApiError('INVALID_ARG', 'GM_cookie.set：value 必须是字符串')
      }
      // 只传 url：domain / path 不开放覆写（开放 domain 会架空域名门，见 api-contract 注释）
      const details: chrome.cookies.SetDetails = { url: req.url, name: req.name, value: req.value }
      if (typeof req.secure === 'boolean') details.secure = req.secure
      if (typeof req.httpOnly === 'boolean') details.httpOnly = req.httpOnly
      if (typeof req.expirationDate === 'number') details.expirationDate = req.expirationDate
      const written = await cookiesApi().set(details)
      if (!written) {
        throw new ApiError('INTERNAL', `GM_cookie.set 被浏览器拒绝：${req.name}`)
      }
      return undefined
    }
    case 'cookie.remove': {
      await assertCookieScope(uuid, req.url)
      if (typeof req.name !== 'string' || !req.name) {
        throw new ApiError('INVALID_ARG', 'GM_cookie.remove：name 必填')
      }
      await cookiesApi().remove({ url: req.url, name: req.name })
      return undefined
    }
    // 二期（DL Port 事件底座）：菜单登记 + store 订阅（控制面，经 Port 回推见 dl-port.ts）
    case 'menu.register':
      await registerScriptMenu(uuid, req.id, req.title)
      return undefined
    case 'menu.unregister':
      await unregisterScriptMenu(uuid, req.id)
      return undefined
    case 'store.watch': {
      // Port 未就绪属竞态防御（正常流程包装层等 port.ready 后才发）
      if (!attachScriptWatch(uuid, req.connId, req.key)) {
        throw new ApiError('INTERNAL', 'DL Port 未就绪，订阅未生效（请重试）')
      }
      return undefined
    }
    case 'store.unwatch':
      detachScriptWatch(uuid, req.connId, req.key)
      return undefined
    // 全量值订阅：只读值的脚本从不做键级订阅，靠这条通道收跨标签页变更
    case 'store.watchAll': {
      if (!attachValueWatch(uuid, req.connId)) {
        throw new ApiError('INTERNAL', 'GM Port 未就绪，全量订阅未生效（请重试）')
      }
      return undefined
    }
    case 'store.unwatchAll':
      detachValueWatch(uuid, req.connId)
      return undefined
    default: {
      // 穷尽性检查：ApiRequest 加新命令时这里会编译报错提醒补 dispatch
      const unreachable: never = req
      void unreachable
      throw new ApiError('INTERNAL', `未实现的 DL 命令`)
    }
  }
}

let initialized = false

/** 注册 GM 桥监听（幂等：SW 闲置重启后会再次 init，避免重复监听） */
export function initDlBridge(): void {
  if (initialized) return
  initialized = true

  // 标签页级存储清理：tab 关闭即删该 tab 在 duoling-usdata 的全部记录；SW 冷启动再对账一遍孤儿记录
  if (chrome.tabs?.onRemoved?.addListener) {
    chrome.tabs.onRemoved.addListener((tabId) => {
      void dropTabKeys(tabId).catch(() => {})
    })
  }
  void reconcileOrphanTabKeys().catch(() => {})
  // 观察型 webRequest：redirect:'manual' 的 3xx 响应读取通道（SW fetch 只拿得到
  // opaqueredirect，探针已证实 webRequest 能看到自家 SW fetch）。顶层注册（MV3 要求）；
  // 无 manual 等待者时立即返回，浏览器全部流量都会路过这里，分发入口必须廉价。
  chrome.webRequest?.onHeadersReceived?.addListener(
    handleObservation,
    { urls: ['*://*/*'] },
    ['responseHeaders', 'extraHeaders'],
  )
  // 规则孤儿对账（用后即撤第二层）：清掉上次崩溃残留的自有区间 session 规则
  void sweepOrphanRules().catch(() => {})

  // 响应机制：onUserScriptMessage 不支持「返回 Promise 作为响应」，必须调 sendResponse
  // 并返回 true 保持通道打开（沿用旧 GM 桥已验证的写法）。
  chrome.runtime.onUserScriptMessage.addListener((raw, sender, sendResponse) => {
    // 网络录制入站：USER_SCRIPT 转发件（us-dl-net）把 MAIN 捕获件的采集送来落库。
    // 载荷形状不可信（经页面可伪造的 postMessage + 两次结构化克隆），故先过 normalizeCapture
    // 白名单化；无响应，仅落库，失败静默（录制不该影响页面网络层）。
    const net = raw as { __dlNetCapture?: true; host?: string; capture?: unknown }
    if (net && net.__dlNetCapture === true) {
      const record = normalizeCapture(net.host, net.capture)
      if (record) void netlog.appendCapture(record).catch(() => {})
      return undefined
    }

    // 运行标识广播（GM 包装注入即发）：交侧边栏监控按 tab 登记。
    const run = raw as { __dlRunStart?: true; uuid?: string; name?: string; runId?: string }
    if (run && run.__dlRunStart === true) {
      const tabId = sender.tab?.id
      if (tabId != null && run.uuid && run.runId) {
        // 侧边栏监控（跨文档观察者）：SW 侧按 tab 登记运行集，面板切 tab 时靠它出快照
        noteRunStart(tabId, run.uuid, run.runId)
      }
      // 运行统计 + 运行日志（runtime 库 stats/runlog store，按脚本聚合落盘）：与 tab 无关，
      // 有无 tabId 都记；同一 runId 的 load 补播在写侧按 lastRunId 去重。失败不影响监控登记。
      if (run.uuid && run.runId) {
        void recordRunStart(run.uuid, run.runId, run.name).catch(() => {})
      }
      return undefined // 仅登记，无需响应
    }

    // 单向错误上报（GM 包装的 window.onerror / unhandledrejection）
    const evt = raw as { __dlEvent?: true; uuid?: string; name?: string; event?: DlEvent }
    if (evt && evt.__dlEvent === true) {
      void appendUserScriptError({
        uuid: evt.uuid ?? null,
        name: evt.name || '未知脚本',
        phase: 'runtime',
        message: evt.event?.message || '',
        stack: evt.event?.stack,
        url: evt.event?.url,
        // 本次运行标识：侧边栏监控据此把错误归属到对应 tab 的运行（缺省视作非本次）
        runId: typeof evt.event?.runId === 'string' ? evt.event.runId : null,
      })
        .then(() => {
          // sender.tab 定位出错页面（userScript 世界消息 sender 带 tab）；拿不到就跳过
          const tabId = sender.tab?.id
          if (tabId != null) {
            // 侧边栏监控：错误行随推送走（落盘记录无 tabId，面板按 tab 归属只能靠这条实时通道）
            notePageError(tabId, {
              uuid: evt.uuid ?? null,
              name: evt.name || '未知脚本',
              message: evt.event?.message || '',
              runId: typeof evt.event?.runId === 'string' ? evt.event.runId : null,
            })
          }
        })
        .catch(() => {})
      return undefined // 仅记录，无需响应
    }

    // 请求-响应
    const msg = raw as { __dl?: true; uuid?: string; req?: ApiRequest }
    if (!msg || msg.__dl !== true || !msg.req) {
      sendResponse({ ok: false, error: '非 DL 消息' } satisfies ApiResponse)
      return undefined
    }

    // 身份校验：消息里的 uuid 必须与脚本运行世界的 scriptId 一致
    // （sender.userScript 可能缺省，缺省时跳过校验——沿用旧 GM 桥的实测结论）
    const scriptId = (sender as { userScript?: { scriptId?: string } }).userScript?.scriptId
    if (scriptId && msg.uuid && scriptId !== msg.uuid) {
      sendResponse({ ok: false, error: '脚本身份不匹配', code: 'PERMISSION_DENIED' } satisfies ApiResponse)
      return undefined
    }
    const uuid = msg.uuid || scriptId
    if (!uuid) {
      sendResponse({ ok: false, error: '缺少脚本标识', code: 'INVALID_ARG' } satisfies ApiResponse)
      return undefined
    }

    void dispatch(uuid, msg.req, sender)
      .then((data) => {
        // 运行时值受契约约束（结构化克隆 + chrome.storage 兼容），这里收窄回 Json | void
        sendResponse({ ok: true, data: data as Json | void } satisfies ApiResponse)
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        const code = e instanceof ApiError ? e.code : 'INTERNAL'
        // 桥调用失败也进错误日志（面板可见）
        void appendUserScriptError({ uuid, name: uuid, phase: 'bridge', message }).catch(() => {})
        sendResponse({ ok: false, error: message, code } satisfies ApiResponse)
      })
    return true // 保持消息通道打开，dispatch 完成后经 sendResponse 回传
  })
}
