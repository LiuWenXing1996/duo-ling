// GM 后台桥（协议契约 @duoling/shared 的 api-contract.ts）。
// 消息分流：信封 `{ __gm: 1, v, kind }` 三种 kind（req / ev / runstart），形状与版本见 api-contract.ts。
// 安全性：消息来源天然是「不可信用户脚本」，故校验 sender.userScript.scriptId 与消息里的 uuid 一致，
// 防止伪造身份读写其它脚本的私有存储。background 的 SW 内 fetch 受 <all_urls> host 权限豁免 CORS，
// 这是 GM_xmlhttpRequest 免 CORS 的基础（Chrome 官方明文：内容脚本中的跨源请求始终按跨源处理）。
import type {
  ApiErrorCode,
  ApiRequest,
  ApiResponse,
  GmCookie,
  ApiNotice,
  FetchFormBody,
  FetchInit,
  FetchPayload,
  Json,
} from '@duoling/shared'
import {
  registerScriptMenu,
  unregisterScriptMenu,
  attachScriptWatch,
  detachScriptWatch,
  attachValueWatch,
  attachAudioWatch,
  detachAudioWatch,
  pushFetchProgress,
  pushDownloadChange,
  mintNotification,
} from './gm-port'
import { checkCookieUrl } from './cookie-gate'

import {
  normalizeNetCapture,
  NET_TAB_KIND,
  LinkError,
  SERVICE_TYPE,
  broadcastDataChange,
  base64ToBytes,
  bytesToBase64,
  errorText,
  BRIDGE_MSG_TAG,
  BRIDGE_MSG_TAG_VALUE,
  BRIDGE_PROTOCOL_VERSION,
} from '@duoling/shared'
import {
  getGMValue,
  setGMValue,
  deleteGMValue,
  setGMValues,
  deleteGMValues,
  getGMValues,
  listGMKeys,
  getAllGMValues,
} from './gm-values'
import * as usdata from './usdata-db'
import {
  splitHeaders,
  hostLock,
  mintRuleId,
  sweepOrphanRules,
  registerManualWaiter,
  handleObservation,
} from './gm-fetch-priv'
import { extensionName, notificationIcon, offscreenPort, telemetryPort } from './host-config'

import { serviceWorkerLink } from './sw-link'

const inFlightFetches = new Map<string, AbortController>()

class ApiError extends Error {
  code: ApiErrorCode
  constructor(code: ApiErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function isBinaryBody(v: unknown): v is { __gmBinaryBody: true; base64: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { __gmBinaryBody?: unknown }).__gmBinaryBody === true &&
    typeof (v as { base64?: unknown }).base64 === 'string'
  )
}

function isFormBody(v: unknown): v is {
  __gmFormData: true
  fields: Array<{ name: string; value?: string; base64?: string; type?: string; filename?: string }>
} {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { __gmFormData?: unknown }).__gmFormData === true &&
    Array.isArray((v as { fields?: unknown }).fields)
  )
}

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

async function readBodyStreaming(
  resp: Response,
  onProgress: (loaded: number, total: number | null) => void,
): Promise<ArrayBuffer> {
  const reader = resp.body?.getReader()
  if (!reader) return await resp.arrayBuffer()
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
  frames++
  onProgress(loaded, total)
  console.debug(`[duoling:gm] 流式读完成：${frames} 帧 / ${loaded} 字节 / total=${total}`)

  const out = new Uint8Array(loaded)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out.buffer
}

async function doFetch(
  url: string,
  init?: FetchInit,
  progress?: (loaded: number, total: number | null) => void,
): Promise<FetchPayload> {
  const redirect = init?.redirect ?? 'follow'
  if (redirect !== 'follow' && redirect !== 'manual' && redirect !== 'error') {
    throw new ApiError(
      'INVALID_ARG',
      `GM_xmlhttpRequest：redirect 仅支持 follow / manual / error，收到「${String(redirect)}」`,
    )
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
      if (headers.has('content-type')) {
        console.warn(
          '[duoling:gm] fetch FormData 请求含手写 content-type，已强制剔除（boundary 由浏览器生成）',
        )
        headers.delete('content-type')
      }
      req.body = rebuildFormData(init.body)
    } else {
      throw new ApiError(
        'INVALID_ARG',
        'GM_xmlhttpRequest：body 仅支持字符串 / Blob / FormData / ArrayBuffer / TypedArray / DataView',
      )
    }
  }

  const lock = hostLock(host)
  const isWriter = dnrOps.length > 0
  if (isWriter) {
    await lock.acquireWriter()
  } else {
    await lock.acquireReader()
  }

  const timeout = init?.timeout
  const controller = new AbortController()
  const requestId = init?.requestId
  if (requestId) inFlightFetches.set(requestId, controller)
  let timer: ReturnType<typeof setTimeout> | undefined
  if (timeout && timeout > 0) {
    timer = setTimeout(
      () =>
        controller.abort(
          new ApiError('BRIDGE_TIMEOUT', `GM_xmlhttpRequest 请求超时（${timeout}ms）：${url}`),
        ),
      timeout,
    )
  }

  let ruleId: number | undefined
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
              condition: { requestDomains: [hostname], initiatorDomains: [chrome.runtime.id] },
            },
          ],
        })
      } catch (e) {
        const msg = errorText(e)
        throw new ApiError('INTERNAL', `GM_xmlhttpRequest：设置请求头覆写规则失败：${msg}`)
      }
    }

    const resp = await fetch(url, {
      credentials: 'omit',
      ...req,
      redirect: redirect === 'follow' ? undefined : redirect,
      signal: controller.signal,
    })

    if (manualWaiter && resp.type === 'opaqueredirect') {
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(controller.signal.reason)
        if (controller.signal.aborted) onAbort()
        else controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      const grace = new Promise<null>((r) => setTimeout(() => r(null), 5000))
      const obs = await Promise.race([manualWaiter.promise, grace, aborted])
      if (!obs) {
        throw new ApiError(
          'INTERNAL',
          `GM_xmlhttpRequest：未能观测到 3xx 响应（webRequest 未见该请求）：${url}`,
        )
      }
      const responseType = init?.responseType === 'arraybuffer' ? 'arraybuffer' : 'text'
      return {
        ok: obs.statusCode >= 200 && obs.statusCode < 300,
        status: obs.statusCode,
        statusText: '',
        headers: obs.headers,
        url,
        body: '',
        responseType,
      }
    }

    const responseHeaders: Record<string, string> = {}
    resp.headers.forEach((v, k) => (responseHeaders[k] = v))
    const responseType = init?.responseType === 'arraybuffer' ? 'arraybuffer' : 'text'
    const bytes = progress ? await readBodyStreaming(resp, progress) : undefined
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
      url: resp.url,
      body,
      responseType,
    }
  } catch (e: unknown) {
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
    if (ruleId !== undefined) {
      try {
        await chrome.declarativeNetRequest?.updateSessionRules?.({ removeRuleIds: [ruleId] })
      } catch {}
    }
    if (isWriter) lock.releaseWriter()
    else lock.releaseReader()
  }
}

function downloadsApi(): typeof chrome.downloads {
  const api = chrome.downloads
  if (!api || typeof api.download !== 'function') {
    throw new ApiError('NOT_AVAILABLE', 'download 能力不可用')
  }
  return api
}

function sanitizeDownloadName(name?: string): string | undefined {
  if (!name) return undefined
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/^\.+/, '').trim()
  return cleaned || undefined
}

type DownloadEntry = {
  uuid: string
  connId: string
  requestId: string
  total: number | null
  timer?: ReturnType<typeof setInterval>
}

const downloadWatch = new Map<number, DownloadEntry>()

const DOWNLOAD_PROGRESS_MS = 500

async function pollDownloadProgress(id: number): Promise<void> {
  const entry = downloadWatch.get(id)
  if (!entry) return
  try {
    const items = await downloadsApi().search({ id })
    const item = items[0]
    if (!item) return
    if (item.state === 'complete' || item.state === 'interrupted') return
    const totalBytes = item.totalBytes
    pushDownloadChange(entry.uuid, entry.connId, {
      requestId: entry.requestId,
      state: 'progress',
      loaded: item.bytesReceived ?? 0,
      total: entry.total ?? (typeof totalBytes === 'number' && totalBytes > 0 ? totalBytes : null),
    })
  } catch {}
}

let downloadWatchMounted = false

function mountDownloadWatch(): void {
  if (downloadWatchMounted) return
  downloadWatchMounted = true
  try {
    downloadsApi().onChanged.addListener((delta) => {
      const entry = downloadWatch.get(delta.id)
      if (!entry) return
      const state = delta.state?.current
      if (state !== 'complete' && state !== 'interrupted') return
      downloadWatch.delete(delta.id)
      if (entry.timer) clearInterval(entry.timer)
      pushDownloadChange(entry.uuid, entry.connId, {
        requestId: entry.requestId,
        state,
        loaded: delta.fileSize?.current ?? 0,
        total: entry.total,
        ...(state === 'interrupted' ? { error: delta.error?.current ?? 'not_succeeded' } : {}),
      })
    })
  } catch {
    downloadWatchMounted = false
  }
}

async function doDownload(
  uuid: string,
  url: string,
  opts: {
    name?: string
    saveAs?: boolean
    conflictAction?: string
    requestId?: string
    connId?: string
    wantProgress?: boolean
  },
): Promise<{ id: number }> {
  const api = downloadsApi()
  const conflict = opts.conflictAction
  if (conflict && conflict !== 'uniquify' && conflict !== 'overwrite' && conflict !== 'prompt') {
    throw new ApiError(
      'INVALID_ARG',
      `GM_download：conflictAction 只支持 uniquify / overwrite / prompt，收到「${conflict}」`,
    )
  }
  const filename = sanitizeDownloadName(opts.name)
  const id = await api.download({
    url,
    ...(filename ? { filename } : {}),
    saveAs: opts.saveAs === true,
    ...(conflict ? { conflictAction: conflict as chrome.downloads.FilenameConflictAction } : {}),
  })
  if (typeof id !== 'number') {
    throw new ApiError('INTERNAL', `GM_download 未能开始下载：${url}`)
  }
  if (opts.requestId && opts.connId) {
    mountDownloadWatch()
    const entry: DownloadEntry = {
      uuid,
      connId: opts.connId,
      requestId: opts.requestId,
      total: null,
    }
    downloadWatch.set(id, entry)
    try {
      const item = (await api.search({ id }))[0]
      const bytes = item?.totalBytes
      entry.total = typeof bytes === 'number' && bytes > 0 ? bytes : null
      if (opts.wantProgress && item && typeof item.bytesReceived === 'number') {
        pushDownloadChange(uuid, opts.connId, {
          requestId: opts.requestId,
          state: 'progress',
          loaded: item.bytesReceived,
          total: entry.total,
        })
      }
    } catch {}
    if (opts.wantProgress) {
      const timer = setInterval(() => {
        void pollDownloadProgress(id)
      }, DOWNLOAD_PROGRESS_MS)
      if (downloadWatch.has(id)) entry.timer = timer
      else clearInterval(timer)
    }
  }
  return { id }
}

function cookiesApi(): typeof chrome.cookies {
  const api = chrome.cookies
  if (!api || typeof api.get !== 'function') {
    throw new ApiError('NOT_AVAILABLE', 'cookie 能力不可用')
  }
  return api
}

async function assertCookieScope(uuid: string, url: string): Promise<void> {
  const gate = await checkCookieUrl(uuid, url)
  if (!gate.ok) throw new ApiError(gate.code, gate.message)
}

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
  if (typeof c.expirationDate === 'number') out.expirationDate = c.expirationDate
  return out
}

async function getTabValue(uuid: string, tabId: number): Promise<Json | undefined> {
  const v = await usdata.getTabValue(uuid, tabId)
  return v === undefined ? undefined : (v as Json)
}

async function saveTabValue(uuid: string, tabId: number, value: Json): Promise<void> {
  await usdata.putTabValue(uuid, tabId, value)
}

async function getAllTabValues(uuid: string): Promise<Record<string, Json>> {
  const all = await usdata.listTabValues(uuid)
  return all as Record<string, Json>
}

async function dropTabKeys(tabId: number): Promise<void> {
  await usdata.deleteTabsByTabId(tabId)
}

async function reconcileOrphanTabKeys(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({})
    const alive = new Set(tabs.map((t) => t.id).filter((id): id is number => id != null))
    await usdata.pruneTabsNotIn(alive)
  } catch {}
}

async function ingestTabRecord(
  kindRaw: unknown,
  record: unknown,
  tabId: number | undefined,
): Promise<void> {
  try {
    if (tabId == null) return
    if (kindRaw !== NET_TAB_KIND) return
    const tabSessionId = await telemetryPort()?.recordingTabSessionId?.(tabId)
    if (!tabSessionId) return
    const rec = normalizeNetCapture(record, tabSessionId)
    if (rec) {
      await telemetryPort()?.appendTabCapture?.(rec)
      broadcastDataChange('tabActivity', tabSessionId)
    }
  } catch {}
}

const CLIPBOARD_TIMEOUT_MS = 2000

async function writeClipboardViaOffscreen(text?: string, html?: string): Promise<void> {
  if (!text && !html) throw new ApiError('INVALID_ARG', 'GM_setClipboard：text 与 html 至少给一个')
  const ready = await offscreenPort()?.ensureReady?.()
  if (!ready) throw new ApiError('NOT_AVAILABLE', 'GM_setClipboard：剪贴板服务不可用')
  const link = serviceWorkerLink()
  if (!link) throw new ApiError('NOT_AVAILABLE', 'GM_setClipboard：链路未建立')

  try {
    await link.request(
      SERVICE_TYPE,
      { method: 'clipboardWrite', args: [{ text: text ?? null, html: html ?? null }] },
      { timeoutMs: CLIPBOARD_TIMEOUT_MS },
    )
  } catch (e) {
    if (e instanceof LinkError && e.code === 'TIMEOUT') {
      throw new ApiError('BRIDGE_TIMEOUT', 'GM_setClipboard 写入超时（2s 无响应）')
    }

    if (e instanceof ApiError) throw e
    throw new ApiError('INTERNAL', 'GM_setClipboard：' + errorText(e))
  }
}
const EVENT_TEXT_MAX = 120

function clipText(s: string): string {
  return s.length > EVENT_TEXT_MAX ? `${s.slice(0, EVENT_TEXT_MAX)}…` : s
}

export function summarizeRunEvent(req: ApiRequest): { kind: string; detail: string } | null {
  switch (req.c) {
    case 'fetch':
      return {
        kind: 'fetch',
        detail: clipText(`${(req.init?.method ?? 'GET').toUpperCase()} ${req.url}`),
      }
    case 'download':
      return { kind: 'download', detail: clipText(req.url) }
    case 'notify':
      return { kind: 'notify', detail: clipText(req.title || '通知') }
    case 'tabs.open':
      return { kind: 'tabs.open', detail: clipText(req.url) }
    case 'clipboard.write':
      return { kind: 'clipboard.write', detail: req.html ? '写入富文本剪贴板' : '写入剪贴板' }
    case 'store.set':
    case 'store.delete':
      return { kind: req.c, detail: clipText(req.key) }
    case 'store.setMany':
      return { kind: 'store.setMany', detail: `${Object.keys(req.entries).length} 个键` }
    case 'store.deleteMany':
      return { kind: 'store.deleteMany', detail: `${req.keys.length} 个键` }
    case 'tab.save':
      return { kind: 'tab.save', detail: '保存标签页数据' }
    case 'cookie.set':
    case 'cookie.remove':
      return { kind: req.c, detail: clipText(req.name) }
    case 'menu.register':
      return { kind: 'menu.register', detail: clipText(req.title) }
    default:
      return null
  }
}

async function dispatch(
  uuid: string,
  req: ApiRequest,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  const tabId = sender.tab?.id
  switch (req.c) {
    case 'store.get': {
      const v = await getGMValue(uuid, req.key)
      return v === undefined ? req.fallback : v
    }
    case 'store.set':
      await setGMValue(uuid, req.key, req.value, req.connId)
      return undefined
    case 'store.delete':
      await deleteGMValue(uuid, req.key, req.connId)
      return undefined
    case 'store.setMany':
      await setGMValues(uuid, req.entries, req.connId)
      return undefined
    case 'store.deleteMany':
      await deleteGMValues(uuid, req.keys, req.connId)
      return undefined
    case 'store.getMany':
      return getGMValues(uuid, req.keys)
    case 'store.keys':
      return listGMKeys(uuid)
    case 'store.all':
      return getAllGMValues(uuid)
    case 'fetch': {
      const rid = req.init?.requestId
      const cid = req.init?.connId
      const progress =
        req.init?.wantProgress && rid && cid
          ? (loaded: number, total: number | null) =>
              pushFetchProgress(uuid, cid, { requestId: rid, loaded, total })
          : undefined
      if (req.init?.wantProgress) {
        console.debug(
          `[duoling:gm] fetch 要进度：rid=${String(rid)} cid=${String(cid)} → 流式=${progress ? '是' : '否'}`,
        )
      }
      return doFetch(req.url, req.init, progress)
    }
    case 'fetch.abort': {
      const controller = inFlightFetches.get(req.requestId)
      if (controller && !controller.signal.aborted) {
        controller.abort(new ApiError('INTERNAL', 'GM_xmlhttpRequest：请求已被脚本中止'))
      }
      return undefined
    }
    case 'notify': {
      const id = mintNotification(uuid)
      await chrome.notifications.create(id, {
        type: 'basic',
        iconUrl: req.icon || notificationIcon(),
        title: req.title || `${extensionName()}用户脚本`,
        message: req.message || '',
      })
      return { id }
    }
    case 'download':
      return doDownload(uuid, req.url, {
        name: req.name,
        saveAs: req.saveAs,
        conflictAction: req.conflictAction,
        requestId: req.requestId,
        connId: req.connId,
        wantProgress: req.wantProgress,
      })
    case 'download.cancel': {
      const entry = downloadWatch.get(req.id)
      try {
        await downloadsApi().cancel(req.id)
      } catch {
        if (entry?.timer) clearInterval(entry.timer)
        downloadWatch.delete(req.id)
      }
      return undefined
    }
    case 'clipboard.write':
      await writeClipboardViaOffscreen(req.text, req.html)
      return undefined
    case 'tab.get': {
      if (tabId == null) throw new ApiError('INVALID_ARG', 'GM_getTab 需要标签页上下文')
      return getTabValue(uuid, tabId)
    }
    case 'tab.save': {
      if (tabId == null) throw new ApiError('INVALID_ARG', 'GM_getTab 需要标签页上下文')
      await saveTabValue(uuid, tabId, req.value)
      return undefined
    }
    case 'tab.all':
      return getAllTabValues(uuid)
    case 'tabs.open': {
      const tab = await chrome.tabs.create({ url: req.url, active: req.active !== false })
      if (tab?.id == null) throw new ApiError('INTERNAL', 'tabs.open 未返回标签页')
      return tab.id
    }
    case 'tabs.close': {
      const target = req.tabId ?? tabId
      if (target == null) throw new ApiError('INTERNAL', 'tabs.close 缺 tabId')
      const closing = await chrome.tabs.get(target).catch(() => undefined)
      if (closing?.windowId != null) {
        const siblings = await chrome.tabs.query({ windowId: closing.windowId })
        if (siblings.length <= 1) {
          throw new ApiError('INVALID_ARG', 'window.close：不允许关闭窗口的最后一个标签页')
        }
      }
      await chrome.tabs.remove(target)
      return undefined
    }
    case 'tabs.focus': {
      const target = req.tabId ?? tabId
      if (target == null) throw new ApiError('INTERNAL', 'tabs.focus 缺 tabId')
      const tab = await chrome.tabs.update(target, { active: true })
      if (tab?.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
      }
      return undefined
    }
    case 'cookie.get': {
      await assertCookieScope(uuid, req.url)
      const filter: chrome.cookies.GetAllDetails = { url: req.url }
      if (req.name != null && req.name !== '') filter.name = req.name
      if (req.domain) filter.domain = req.domain
      if (req.path) filter.path = req.path
      const all = await cookiesApi().getAll(filter)
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
      const details: chrome.cookies.SetDetails = { url: req.url, name: req.name, value: req.value }
      if (typeof req.secure === 'boolean') details.secure = req.secure
      if (typeof req.httpOnly === 'boolean') details.httpOnly = req.httpOnly
      if (typeof req.expirationDate === 'number') details.expirationDate = req.expirationDate
      if (typeof req.domain === 'string' && req.domain) details.domain = req.domain
      if (typeof req.path === 'string' && req.path) details.path = req.path
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
      const api = cookiesApi()
      if (req.domain || req.path) {
        const found = await api.getAll({
          url: req.url,
          name: req.name,
          ...(req.domain ? { domain: req.domain } : {}),
          ...(req.path ? { path: req.path } : {}),
        })
        for (const c of found) {
          const scheme = c.secure ? 'https' : 'http'
          await api.remove({
            url: `${scheme}://${c.domain.replace(/^\./, '')}${c.path}`,
            name: c.name,
          })
        }
        return undefined
      }
      await api.remove({ url: req.url, name: req.name })
      return undefined
    }
    case 'menu.register':
      await registerScriptMenu(uuid, req.id, req.title)
      return undefined
    case 'menu.unregister':
      await unregisterScriptMenu(uuid, req.id)
      return undefined
    case 'store.watch': {
      if (!attachScriptWatch(uuid, req.connId, req.key)) {
        throw new ApiError('INTERNAL', '事件通道未就绪，订阅未生效（请重试）')
      }
      return undefined
    }
    case 'store.unwatch':
      detachScriptWatch(uuid, req.connId, req.key)
      return undefined
    case 'store.watchAll': {
      if (!attachValueWatch(uuid, req.connId)) {
        throw new ApiError('INTERNAL', '事件通道未就绪，订阅未生效（请重试）')
      }
      return undefined
    }
    case 'audio.setMute': {
      if (tabId == null) throw new ApiError('INTERNAL', 'audio.setMute 取不到当前标签页')
      await chrome.tabs.update(tabId, { muted: req.isMuted })
      return undefined
    }
    case 'audio.getState': {
      if (tabId == null) throw new ApiError('INTERNAL', 'audio.getState 取不到当前标签页')
      const tab = await chrome.tabs.get(tabId)
      return {
        ...(tab.mutedInfo ? { isMuted: tab.mutedInfo.muted } : {}),
        ...(tab.mutedInfo?.reason ? { muteReason: tab.mutedInfo.reason } : {}),
        ...(tab.audible !== undefined ? { isAudible: tab.audible } : {}),
      }
    }
    case 'audio.watch': {
      if (!attachAudioWatch(uuid, req.connId)) {
        throw new ApiError('INTERNAL', '事件通道未就绪，订阅未生效（请重试）')
      }
      return undefined
    }
    case 'audio.unwatch':
      detachAudioWatch(uuid, req.connId)
      return undefined
    default: {
      const unreachable: never = req
      void unreachable
      throw new ApiError('INTERNAL', `未实现的命令`)
    }
  }
}

let initialized = false

const scriptNameByUuid = new Map<string, string>()

export function initGmBridge(): void {
  if (initialized) return
  initialized = true

  if (chrome.tabs?.onRemoved?.addListener) {
    chrome.tabs.onRemoved.addListener((tabId) => {
      void dropTabKeys(tabId).catch(() => {})
    })
  }
  void reconcileOrphanTabKeys().catch(() => {})
  chrome.webRequest?.onHeadersReceived?.addListener(handleObservation, { urls: ['*://*/*'] }, [
    'responseHeaders',
    'extraHeaders',
  ])
  void sweepOrphanRules().catch(() => {})

  chrome.runtime.onUserScriptMessage.addListener((raw, sender, sendResponse) => {
    const frame = raw as Record<string, unknown> | null
    const isCurrent = !!frame && frame[BRIDGE_MSG_TAG] === BRIDGE_MSG_TAG_VALUE
    const isLegacy =
      !!frame && (frame.__dl === true || frame.__dlEvent === true || frame.__dlRunStart === true)
    if (!isCurrent) {
      const req = (frame as { req?: unknown } | null)?.req
      if (isLegacy && req) {
        sendResponse({
          ok: false,
          error: '脚本桥协议已更新，请刷新页面后重试',
          code: 'BRIDGE_VERSION_MISMATCH',
        } satisfies ApiResponse)
      }
      return undefined
    }
    if (frame!.v !== BRIDGE_PROTOCOL_VERSION) {
      const req = (frame as { req?: unknown }).req
      if (req) {
        sendResponse({
          ok: false,
          error: '脚本桥协议版本不符，请刷新页面后重试',
          code: 'BRIDGE_VERSION_MISMATCH',
        } satisfies ApiResponse)
      }
      return undefined
    }

    const run = frame as {
      kind?: unknown
      uuid?: string
      name?: string
      runId?: string
      url?: string
      savedAt?: number
    }
    if (run.kind === 'runstart') {
      const tabId = sender.tab?.id
      if (tabId != null && run.uuid && run.runId) {
        telemetryPort()?.noteRunStart?.(tabId, run.uuid, run.runId)
      }
      if (run.uuid && run.name) scriptNameByUuid.set(run.uuid, run.name)
      const uuid = run.uuid
      const runId = run.runId
      if (uuid && runId && tabId != null) {
        const extra = {
          ...(typeof run.url === 'string' ? { url: run.url } : {}),
          ...(typeof run.savedAt === 'number' ? { savedAt: run.savedAt } : {}),
        }
        void Promise.resolve(telemetryPort()?.recordingTabSessionId?.(tabId))
          .then((tabSessionId) =>
            tabSessionId
              ? telemetryPort()?.recordRunStart?.(uuid, runId, run.name, { ...extra, tabSessionId })
              : undefined,
          )
          .catch(() => {})
      }
      return undefined
    }

    const evt = frame as { kind?: unknown; uuid?: string; name?: string; event?: ApiNotice }
    if (evt.kind === 'ev') {
      const event = evt.event
      if (event && event.t === 'tab.record') {
        void ingestTabRecord(event.kind, event.record, sender.tab?.id)
        return undefined
      }
      if (event && event.t === 'inspector.result') {
        telemetryPort()?.onInspectorEvent?.(evt.uuid ?? '', sender.tab?.id ?? null, {
          reqId: event.reqId,
          ok: event.ok,
          payload: event.payload,
        })
        return undefined
      }
      if (event && event.t === 'float.pong') {
        telemetryPort()?.onFloatEvent?.(evt.uuid ?? '', sender.tab?.id ?? null, {
          reqId: event.reqId,
        })
        return undefined
      }
      const tabId = sender.tab?.id
      if (tabId == null) return undefined
      void Promise.resolve(telemetryPort()?.recordingTabSessionId?.(tabId))
        .then((tabSessionId) => {
          if (!tabSessionId) return
          return telemetryPort()
            ?.appendError?.({
              uuid: evt.uuid ?? null,
              name: evt.name || '未知脚本',
              phase: 'runtime',
              message: event?.message || '',
              stack: event?.stack,
              url: event?.url,
              runId: typeof event?.runId === 'string' ? event.runId : null,
              tabSessionId,
            })
            .then(() => {
              telemetryPort()?.notePageError?.(tabId, {
                uuid: evt.uuid ?? null,
                name: evt.name || '未知脚本',
                message: event?.message || '',
                runId: typeof event?.runId === 'string' ? event.runId : null,
              })
            })
        })
        .catch(() => {})
      return undefined
    }

    const msg = frame as { kind?: unknown; uuid?: string; runId?: string; req?: ApiRequest }
    if (msg.kind !== 'req' || !msg.req) {
      sendResponse({ ok: false, error: '非脚本桥消息' } satisfies ApiResponse)
      return undefined
    }

    const scriptId = (sender as { userScript?: { scriptId?: string } }).userScript?.scriptId
    if (scriptId && msg.uuid && scriptId !== msg.uuid) {
      sendResponse({
        ok: false,
        error: '脚本身份不匹配',
        code: 'PERMISSION_DENIED',
      } satisfies ApiResponse)
      return undefined
    }
    const uuid = msg.uuid || scriptId
    if (!uuid) {
      sendResponse({ ok: false, error: '缺少脚本标识', code: 'INVALID_ARG' } satisfies ApiResponse)
      return undefined
    }

    if (msg.runId) {
      const ev = summarizeRunEvent(msg.req)
      if (ev)
        void telemetryPort()
          ?.recordRunEvent?.(uuid, msg.runId, { ...ev, time: Date.now() })
          .catch(() => {})
    }

    void dispatch(uuid, msg.req, sender)
      .then((data) => {
        sendResponse({ ok: true, data: data as Json | void } satisfies ApiResponse)
      })
      .catch((e: unknown) => {
        const message = errorText(e)
        const code = e instanceof ApiError ? e.code : 'INTERNAL'
        void telemetryPort()
          ?.appendError?.({
            uuid,
            name: scriptNameByUuid.get(uuid) ?? uuid,
            phase: 'bridge',
            message,
            ...(msg.runId ? { runId: msg.runId } : {}),
          })
          .catch(() => {})
        sendResponse({ ok: false, error: message, code } satisfies ApiResponse)
      })
    return true
  })
}
