// GM 包装运行时（MAIN 世界，先于脚本源码提供 GM_* / GM.*）；设计决策见 docs/adr/0001 与 ARCHITECTURE「脚本注入」。
import type { GmInfo } from '@duoling/shared'
import { createGmBridgeClient } from './gm-bridge-client'

export interface GmWrapperEnv {
  uuid: string
  name: string
  values: Record<string, unknown>
  info: Omit<GmInfo, 'userAgent' | 'isIncognito'>
  pageSecret: string
  exposure: Record<string, boolean>
  resources: Record<string, { text: string; url: string }>
  savedAt: number | null
  runAtBody: boolean
}

export interface GmWrapperHandle {
  members: Record<string, unknown>
  runBody: (fn: () => void) => void
}

export function installGmWrapper(env: GmWrapperEnv): GmWrapperHandle {
  const GM_INFO = env.info as GmInfo
  GM_INFO.userAgent = navigator.userAgent
  try {
    GM_INFO.isIncognito = !!(
      typeof chrome !== 'undefined' &&
      chrome.extension &&
      chrome.extension.inIncognitoContext
    )
  } catch {
    GM_INFO.isIncognito = false
  }
  const GM_HAS = env.exposure
  const GM_VALUES = env.values
  const GM_RESOURCES = env.resources
  const NAME_PREFIX = '[GM:' + env.name + ']'

  const __gmBridge = createGmBridgeClient(window, env.pageSecret, env.uuid)
  __gmBridge.onEvent(function (ev: any) {
    __gmHandleEvent(ev)
  })

  const __gmRunId = (function () {
    try {
      return crypto.randomUUID()
    } catch {
      return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    }
  })()
  const __gmSrcSavedAt = env.savedAt ?? null
  function __gmAnnounceRun() {
    try {
      const p = __gmBridge.emit({
        kind: 'runstart',
        name: GM_INFO.script.name,
        runId: __gmRunId,
        url: location.href,
        savedAt: __gmSrcSavedAt,
      })
      if (p && typeof p.catch === 'function') p.catch(function () {})
    } catch {}
  }
  __gmAnnounceRun()
  if (document.readyState !== 'complete') window.addEventListener('load', __gmAnnounceRun)

  function __gmLog(...parts: unknown[]): void {
    try {
      console.log.apply(console, [NAME_PREFIX].concat(parts as any))
    } catch {}
  }

  const __gmSrcMark = 'duoling://script/' + env.uuid + '/'
  function __gmOwnStack(stack: unknown): boolean {
    return typeof stack === 'string' && stack.indexOf(__gmSrcMark) !== -1
  }
  function __gmReportError(message: any, stack: any, url: any): void {
    try {
      const p = __gmBridge.emit({
        kind: 'notice',
        name: GM_INFO.script.name,
        event: {
          t: 'error',
          phase: 'runtime',
          message: message,
          stack: stack,
          url: url,
          runId: __gmRunId,
        },
      })
      if (p && typeof p.catch === 'function') p.catch(function () {})
    } catch (e: any) {
      console.warn('[duoling:userscript] 上报异常：' + ((e && e.message) || e))
    }
  }
  function __gmReportCaught(e: any): void {
    __gmReportError((e && e.message) || String(e), (e && e.stack) || '', location.href)
  }
  window.addEventListener('error', function (e: any) {
    const err = e.error || {}
    const stack = (err && err.stack) || ''
    if (!__gmOwnStack(stack)) return
    __gmReportError(e.message || 'Script error', stack, location.href)
  })
  window.addEventListener('unhandledrejection', function (e: any) {
    const r = (e && e.reason) || {}
    const stack = (r && r.stack) || ''
    if (!__gmOwnStack(stack)) return
    __gmReportError(
      'Unhandled rejection: ' + ((r && r.message) || String(e.reason)),
      stack,
      location.href,
    )
  })

  function __gmSend(req: any): Promise<any> {
    return __gmBridge.call(req, __gmRunId).then(function (resp: any) {
      if (!resp) {
        const e: any = new Error('GM 调用无响应：' + (req && req.c))
        e.code = 'BRIDGE_NO_RESPONSE'
        throw e
      }
      if (!resp.ok) {
        const e2: any = new Error(resp.error || 'GM 调用失败')
        if (resp.code) e2.code = resp.code
        throw e2
      }
      return resp.data
    })
  }

  const __gmConnId = (function () {
    try {
      return crypto.randomUUID()
    } catch {
      return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    }
  })()
  let __gmConnectStarted = false
  let __gmPortReady = false
  const __gmReadyWaiters: Array<{ resolve: () => void }> = []
  const __gmMenuHandlers: Record<string, any> = {}
  const __gmWatchHandlers: Record<string, Array<{ id: number; fn: any }>> = {}
  const __gmNotifyHandlers: Record<string, any> = {}
  let __gmUrlChangeHandler: any = null

  function __gmMenuId(caption: any): number {
    let h = 5381
    const s = String(caption || 'menu')
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
    return h >>> 0
  }
  function __gmMenuKey(caption: any): string {
    return 'm-' + __gmMenuId(caption).toString(36)
  }

  function __gmFireUrlChange(url: string): void {
    const obj = { url: url }
    if (__gmUrlChangeHandler) {
      try {
        __gmUrlChangeHandler(obj)
      } catch (e: any) {
        __gmLog('onurlchange 回调异常', e)
      }
    }
    try {
      window.dispatchEvent(new CustomEvent('urlchange', { detail: obj }))
    } catch {}
  }

  function __gmHandleEvent(ev: any): void {
    if (!ev) return
    if (ev.t === 'port.ready') {
      __gmPortReady = true
      const ws = __gmReadyWaiters.splice(0)
      for (let wi = 0; wi < ws.length; wi++) ws[wi].resolve()
      return
    }
    if (ev.t === 'menu.click') {
      const mh = __gmMenuHandlers[ev.id]
      if (mh) {
        try {
          mh()
        } catch (e: any) {
          __gmLog('菜单回调异常', e)
        }
      }
    } else if (ev.t === 'store.change') {
      if (ev.value === null) delete GM_VALUES[ev.key]
      else GM_VALUES[ev.key] = ev.value
      delete __gmPendingWrites[ev.key]
      const cbs = __gmWatchHandlers[ev.key]
      if (cbs) {
        for (let i = 0; i < cbs.length; i++) {
          const entry = cbs[i]
          try {
            entry.fn(
              ev.key,
              ev.oldValue == null ? undefined : ev.oldValue,
              ev.value == null ? undefined : ev.value,
              !!ev.remote,
            )
          } catch (e: any) {
            __gmLog('GM_addValueChangeListener 回调异常', e)
          }
        }
      }
    } else if (ev.t === 'notify.click') {
      const nh = __gmNotifyHandlers[ev.id]
      if (nh) {
        try {
          nh()
        } catch (e: any) {
          __gmLog('通知点击回调异常', e)
        }
      }
    } else if (ev.t === 'audio.change') {
      const ae: any = {}
      if ('muted' in ev) ae.muted = ev.muted
      if ('audible' in ev) ae.audible = ev.audible
      __gmFireAudioChange(ae)
    } else if (ev.t === 'xhr.progress') {
      const ph = __gmXhrProgress[ev.requestId]
      if (ph) {
        try {
          ph({ loaded: ev.loaded, total: ev.total, lengthComputable: ev.total != null })
        } catch (e: any) {
          __gmLog('onprogress 回调异常', e)
        }
      }
    } else if (ev.t === 'download.change') {
      const dh = __gmDownloadHandlers[ev.requestId]
      if (dh) {
        if (ev.state === 'progress') {
          if (typeof dh.onprogress === 'function') {
            try {
              dh.onprogress({
                loaded: ev.loaded,
                total: ev.total,
                lengthComputable: ev.total != null,
              })
            } catch (e: any) {
              __gmLog('GM_download onprogress 异常', e)
            }
          }
        } else {
          __gmUnregisterDownload(ev.requestId)
          if (ev.state === 'complete') {
            if (typeof dh.onload === 'function') {
              try {
                dh.onload()
              } catch (e: any) {
                __gmLog('GM_download onload 异常', e)
              }
            }
          } else if (typeof dh.onerror === 'function') {
            try {
              dh.onerror({ error: ev.error || 'not_succeeded' })
            } catch (e: any) {
              __gmLog('GM_download onerror 异常', e)
            }
          }
        }
      }
    }
  }

  function __gmConnect(): void {
    if (__gmConnectStarted) return
    __gmConnectStarted = true
    __gmBridge.connect(__gmConnId).catch(function (e: any) {
      __gmConnectStarted = false
      console.warn(NAME_PREFIX + ' 事件通道连接失败：' + ((e && e.message) || e))
    })
  }

  function __gmWaitReady(): Promise<void> {
    if (__gmPortReady) return Promise.resolve()
    __gmConnect()
    return new Promise<void>(function (resolve, reject) {
      let done = false
      const timer = setTimeout(function () {
        if (done) return
        done = true
        const i = __gmReadyWaiters.indexOf(w)
        if (i >= 0) __gmReadyWaiters.splice(i, 1)
        reject(new Error('GM 事件通道连接超时（8s 未就绪）'))
      }, 8000)
      const w = {
        resolve: function () {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve()
        },
      }
      __gmReadyWaiters.push(w)
    })
  }

  function __gmRegSend(req: any): Promise<any> {
    if (__gmPortReady) return __gmSend(req)
    return __gmWaitReady().then(function () {
      return __gmSend(req)
    })
  }

  function __gmSendAfterChannel(req: any): Promise<any> {
    if (__gmPortReady) return __gmSend(req)
    return __gmWaitReady()
      .catch(function (e: any) {
        console.warn(
          NAME_PREFIX +
            ' 下行通道未就绪，本次调用的进度 / 完成回调会收不到：' +
            ((e && e.message) || e),
        )
      })
      .then(function () {
        return __gmSend(req)
      })
  }

  const __gmPendingWrites: Record<string, boolean> = {}
  function __gmHas(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(GM_VALUES, key)
  }
  function __gmGetSync(key: string, def: any): any {
    return __gmHas(key) ? GM_VALUES[key] : def
  }
  function __gmListSync(): string[] {
    return Object.keys(GM_VALUES)
  }

  let __gmChannelReady: Promise<void> | null = null
  function __gmEnsureChannel(): Promise<void> {
    if (__gmChannelReady) return __gmChannelReady
    __gmChannelReady = new Promise<void>(function (resolve) {
      __gmConnect()
      __gmWaitReady()
        .then(function () {
          return __gmRegSend({ c: 'store.watchAll', connId: __gmConnId })
        })
        .then(function () {
          return __gmSend({ c: 'store.all' }).then(function (all: any) {
            const fresh = all || {}
            for (const k in fresh)
              if (Object.prototype.hasOwnProperty.call(fresh, k) && !__gmPendingWrites[k])
                GM_VALUES[k] = fresh[k]
            for (const old in GM_VALUES)
              if (!Object.prototype.hasOwnProperty.call(fresh, old) && !__gmPendingWrites[old])
                delete GM_VALUES[old]
          })
        })
        .then(resolve, function (e: any) {
          console.warn(
            NAME_PREFIX +
              ' 值通道未就绪（跨标签页变更暂不可见，同步读仍可用快照）：' +
              ((e && e.message) || e),
          )
          resolve()
        })
    })
    return __gmChannelReady
  }

  function __gmSetSync(key: any, value: any, isDelete: any): Promise<void> {
    if (isDelete) delete GM_VALUES[key]
    else GM_VALUES[key] = value
    __gmPendingWrites[key] = true
    const req = isDelete
      ? { c: 'store.delete', key: key, connId: __gmConnId }
      : { c: 'store.set', key: key, value: value, connId: __gmConnId }
    return __gmSend(req).then(
      function () {
        delete __gmPendingWrites[key]
      },
      function (e: any) {
        delete __gmPendingWrites[key]
        __gmLog(
          (isDelete ? 'GM_deleteValue' : 'GM_setValue') + ' 落盘失败：' + ((e && e.message) || e),
        )
        throw e
      },
    )
  }

  function __gmSetManySync(input: any, isDelete: any): Promise<void> {
    const keys: any[] = isDelete ? (input || []).slice() : Object.keys(input || {})
    if (!keys.length) return Promise.resolve()
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]
      if (isDelete) delete GM_VALUES[k]
      else GM_VALUES[k] = input[k]
      __gmPendingWrites[k] = true
    }
    const req = isDelete
      ? { c: 'store.deleteMany', keys: keys, connId: __gmConnId }
      : { c: 'store.setMany', entries: input, connId: __gmConnId }
    return __gmSend(req).then(
      function () {
        for (let j = 0; j < keys.length; j++) delete __gmPendingWrites[keys[j]]
      },
      function (e: any) {
        for (let j = 0; j < keys.length; j++) delete __gmPendingWrites[keys[j]]
        __gmLog(
          (isDelete ? 'GM_deleteValues' : 'GM_setValues') + ' 落盘失败：' + ((e && e.message) || e),
        )
        throw e
      },
    )
  }

  function __gmPickValues(source: any, keysOrDefaults: any): any {
    const out: any = {}
    if (keysOrDefaults == null) {
      for (const k in source)
        if (Object.prototype.hasOwnProperty.call(source, k)) out[k] = source[k]
      return out
    }
    if (Array.isArray(keysOrDefaults)) {
      for (let i = 0; i < keysOrDefaults.length; i++) {
        const key = keysOrDefaults[i]
        if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key]
      }
      return out
    }
    for (const d in keysOrDefaults)
      if (Object.prototype.hasOwnProperty.call(keysOrDefaults, d)) {
        out[d] = Object.prototype.hasOwnProperty.call(source, d) ? source[d] : keysOrDefaults[d]
      }
    return out
  }

  function __gmBase64ToArrayBuffer(b64: string): ArrayBuffer {
    const bin = atob(b64)
    const buf = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
    return buf.buffer
  }
  function __gmBytesToBase64(bytes: Uint8Array): string {
    let s = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as any)
    }
    return btoa(s)
  }
  function __gmCopyInit(s: any): any {
    const c: any = {}
    for (const k in s)
      if (Object.prototype.hasOwnProperty.call(s, k) && s[k] !== undefined) c[k] = s[k]
    return c
  }
  function __gmCopyHeaders(h: any): any {
    const c: any = {}
    for (const k in h) if (Object.prototype.hasOwnProperty.call(h, k)) c[k] = h[k]
    return c
  }
  function __gmEncodeBody(raw: any): Promise<any> {
    if (raw == null) return Promise.resolve(null)
    if (typeof raw === 'string')
      return Promise.resolve(function (s: any) {
        var c = __gmCopyInit(s)
        c.body = raw
        return c
      })
    if (typeof Blob !== 'undefined' && raw instanceof Blob) {
      return raw.arrayBuffer().then(function (buf: ArrayBuffer) {
        const bin = { __gmBinaryBody: true, base64: __gmBytesToBase64(new Uint8Array(buf)) }
        return function (s: any) {
          const c = __gmCopyInit(s)
          c.body = bin
          const t = raw.type
          if (t && (!c.headers || c.headers['content-type'] == null)) {
            c.headers = __gmCopyHeaders(c.headers || {})
            c.headers['content-type'] = t
          }
          return c
        }
      })
    }
    if (typeof FormData !== 'undefined' && raw instanceof FormData) {
      const fields: any[] = []
      const pending: Array<Promise<void>> = []
      raw.forEach(function (value, name) {
        if (typeof value === 'string') {
          fields.push({ name: name, value: value })
        } else {
          pending.push(
            value.arrayBuffer().then(function (buf: ArrayBuffer) {
              const f =
                typeof File !== 'undefined' && value instanceof File ? value.name : undefined
              fields.push({
                name: name,
                base64: __gmBytesToBase64(new Uint8Array(buf)),
                type: value.type || 'application/octet-stream',
                filename: f,
              })
            }),
          )
        }
      })
      return Promise.all(pending).then(function () {
        return function (s: any) {
          const c = __gmCopyInit(s)
          c.body = { __gmFormData: true, fields: fields }
          return c
        }
      })
    }
    if (typeof raw === 'object') {
      let bytes: Uint8Array
      if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw)
      else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(raw))
        bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
      else
        return Promise.reject(
          new Error(
            'GM_xmlhttpRequest：data 仅支持 string / Blob / FormData / ArrayBuffer / TypedArray / DataView',
          ),
        )
      const bin2 = { __gmBinaryBody: true, base64: __gmBytesToBase64(bytes) }
      return Promise.resolve(function (s: any) {
        const c = __gmCopyInit(s)
        c.body = bin2
        return c
      })
    }
    return Promise.reject(
      new Error(
        'GM_xmlhttpRequest：data 仅支持 string / Blob / FormData / ArrayBuffer / TypedArray / DataView',
      ),
    )
  }

  function __gmAddStyle(css: string): HTMLElement {
    const el = document.createElement('style')
    el.textContent = css
    ;(document.head || document.documentElement)!.appendChild(el)
    return el
  }
  function __gmAddElement(a: any, b?: any, c?: any): HTMLElement {
    let parent: any, tag: any, attrs: any
    if (typeof a === 'string') {
      parent = document.head || document.documentElement
      tag = a
      attrs = b
    } else {
      parent = a
      tag = b
      attrs = c
    }
    const el = document.createElement(tag)
    if (attrs) {
      for (const k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue
        try {
          el.setAttribute(k, attrs[k])
        } catch {}
      }
    }
    if (parent && parent.appendChild) parent.appendChild(el)
    return el
  }
  function __gmTriggerAnchor(href: string, name?: string): void {
    const a = document.createElement('a')
    a.href = href
    a.download = name || 'download'
    ;(document.body || document.documentElement)!.appendChild(a)
    a.click()
    a.remove()
  }
  function __gmRawHeaders(obj: any): string {
    let out = ''
    for (const k in obj)
      if (Object.prototype.hasOwnProperty.call(obj, k)) out += k + ': ' + obj[k] + '\r\n'
    return out
  }
  function __gmWithCb(p: Promise<any>, cb: any): void {
    if (typeof cb !== 'function') return
    p.then(
      function (v: any) {
        try {
          cb(v)
        } catch {}
      },
      function (e: any) {
        try {
          cb(undefined, (e && e.message) || String(e))
        } catch {}
      },
    )
  }
  function __gmWithErrCb(p: Promise<any>, cb: any): void {
    if (typeof cb !== 'function') return
    p.then(
      function () {
        try {
          cb(null)
        } catch {}
      },
      function (e: any) {
        try {
          cb((e && e.message) || String(e))
        } catch {}
      },
    )
  }

  function __gmXhr(details: any): any {
    const d = details || {}
    const requestId = (function () {
      try {
        return crypto.randomUUID()
      } catch {
        return 'x-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
      }
    })()
    const rt = d.responseType
    let responseType = rt === 'json' || rt === 'arraybuffer' || rt === 'blob' ? rt : 'text'
    if (rt === 'document' || rt === 'stream') {
      __gmLog('GM_xmlhttpRequest：responseType「' + rt + '」不受支持，已按 text 处理')
      responseType = 'text'
    }
    let aborted = false
    function base(status: number, statusText: string, headers: any, url: string): any {
      return {
        readyState: 4,
        status: status,
        statusText: statusText,
        responseHeaders: __gmRawHeaders(headers || {}),
        finalUrl: url || d.url,
        context: d.context,
      }
    }
    function toResponse(p: any): any {
      const r = base(p.status, p.statusText, p.headers, p.url)
      const text = p.body || ''
      r.responseText = responseType === 'text' || responseType === 'json' ? text : ''
      if (responseType === 'arraybuffer') r.response = __gmBase64ToArrayBuffer(text)
      else if (responseType === 'blob')
        r.response = new Blob([__gmBase64ToArrayBuffer(text)], {
          type: (p.headers && p.headers['content-type']) || '',
        })
      else if (responseType === 'json') {
        try {
          r.response = JSON.parse(text)
        } catch {
          r.response = null
        }
      } else r.response = text
      return r
    }
    const handle = {
      abort: function () {
        if (aborted) return
        aborted = true
        __gmSend({ c: 'fetch.abort', requestId: requestId }).catch(function () {})
        if (d.onabort) {
          try {
            d.onabort(base(0, '', {}, d.url))
          } catch {}
        }
      },
    }
    if (d.onloadstart) {
      try {
        d.onloadstart(base(0, '', {}, d.url))
      } catch {}
    }
    const chain = __gmEncodeBody(d.data).then(function (encode: any) {
      const wantsProgress = typeof d.onprogress === 'function'
      if (wantsProgress) __gmRegisterXhrProgress(requestId, d.onprogress)
      const init = {
        method: d.method,
        headers: d.headers,
        responseType: responseType === 'text' || responseType === 'json' ? 'text' : 'arraybuffer',
        timeout: d.timeout,
        redirect: d.redirect,
        requestId: requestId,
        wantProgress: wantsProgress,
        connId: __gmConnId,
      }
      const sendReq = wantsProgress ? __gmSendAfterChannel : __gmSend
      return sendReq({ c: 'fetch', url: d.url, init: encode ? encode(init) : init })
    })
    const progressDone = function () {
      __gmUnregisterXhrProgress(requestId)
    }
    chain.then(progressDone, progressDone)
    chain.then(
      function (p: any) {
        if (aborted) return
        const resp = toResponse(p)
        if (d.onreadystatechange) {
          try {
            d.onreadystatechange(resp)
          } catch {}
        }
        if (d.onload) {
          try {
            d.onload(resp)
          } catch {}
        }
      },
      function (e: any) {
        if (aborted) return
        const code = e && e.code
        const r = base(0, '', {}, d.url)
        if (code === 'BRIDGE_TIMEOUT') {
          if (d.ontimeout) {
            try {
              d.ontimeout(r)
            } catch {}
          }
          return
        }
        if (d.onerror) {
          const errResp = base(0, '', {}, d.url)
          errResp.error = (e && e.message) || '请求失败'
          try {
            d.onerror(errResp)
          } catch {}
        }
      },
    )
    return handle
  }

  const __gmDownloadHandlers: Record<string, any> = {}
  let __gmDownloadSeq = 0
  function __gmUnregisterDownload(id: string): void {
    delete __gmDownloadHandlers[id]
  }

  function __gmDownloadUrl(d: any): any {
    const wantsProgress = typeof d.onprogress === 'function'
    const wantsFrames =
      wantsProgress || typeof d.onload === 'function' || typeof d.onerror === 'function'
    const requestId = '__gmDl' + ++__gmDownloadSeq
    if (wantsFrames) __gmDownloadHandlers[requestId] = d
    let downloadId: number | null = null
    let abortEarly = false
    const abortDownload = function () {
      if (typeof downloadId === 'number') {
        __gmSend({ c: 'download.cancel', id: downloadId }).catch(function () {})
      } else {
        abortEarly = true
      }
    }
    const sendReq = wantsFrames ? __gmSendAfterChannel : __gmSend
    const p: any = sendReq({
      c: 'download',
      url: d.url,
      name: d.name,
      saveAs: d.saveAs === true,
      conflictAction: d.conflictAction,
      requestId: wantsFrames ? requestId : undefined,
      connId: wantsFrames ? __gmConnId : undefined,
      wantProgress: wantsProgress,
    }).then(
      function (r: any) {
        downloadId = r && r.id
        if (abortEarly) abortDownload()
        return r
      },
      function (e: any) {
        __gmUnregisterDownload(requestId)
        if (typeof d.onerror === 'function') {
          try {
            d.onerror({ error: (e && e.message) || 'not_succeeded' })
          } catch {}
        }
        throw e
      },
    )
    p.abort = abortDownload
    return p
  }

  function __gmDownload(input: any, name?: string): Promise<void> {
    if (typeof input === 'string') return __gmDownloadUrl({ url: input, name: name })
    if (input && typeof input === 'object' && typeof input.url === 'string')
      return __gmDownloadUrl(input)
    let blob: Blob | null = null
    if (typeof Blob !== 'undefined' && input instanceof Blob) blob = input
    else if (input instanceof ArrayBuffer) blob = new Blob([input])
    else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(input))
      blob = new Blob([
        new Uint8Array(input.buffer as ArrayBuffer, input.byteOffset, input.byteLength),
      ])
    if (!blob)
      return Promise.reject(
        new Error(
          'GM_download：首参仅支持 URL 字符串 / details 对象 / Blob / ArrayBuffer / TypedArray',
        ),
      )
    const url = URL.createObjectURL(blob)
    try {
      __gmTriggerAnchor(url, name)
    } finally {
      setTimeout(function () {
        URL.revokeObjectURL(url)
      }, 1000)
    }
    return Promise.resolve()
  }

  function __gmOpenInTab(url: string, options: any): any {
    let active = true
    if (typeof options === 'boolean') active = options
    else if (options && typeof options === 'object' && typeof options.active === 'boolean')
      active = options.active
    let tabId: number | null = null
    let pendingClose = false
    const handle = {
      closed: false,
      close: function () {
        if (handle.closed) return
        handle.closed = true
        if (tabId == null) {
          pendingClose = true
          return
        }
        __gmSend({ c: 'tabs.close', tabId: tabId }).catch(function () {})
      },
    }
    __gmSend({ c: 'tabs.open', url: url, active: active }).then(
      function (id: any) {
        tabId = id
        if (pendingClose) handle.close()
      },
      function (e: any) {
        __gmLog('GM_openInTab 失败：' + ((e && e.message) || e))
      },
    )
    return handle
  }

  function __gmNotify(a: any, b?: any, c?: any, d?: any): Promise<any> {
    let msg: any, title: any, icon: any, onclick: any
    if (a && typeof a === 'object') {
      msg = a.text
      title = a.title
      icon = a.image
      onclick = a.onclick
    } else {
      msg = a
      title = b
      icon = c
      onclick = d
    }
    const sendReq = typeof onclick === 'function' ? __gmSendAfterChannel : __gmSend
    return sendReq({
      c: 'notify',
      message: String(msg == null ? '' : msg),
      title: title,
      icon: icon,
    }).then(function (r: any) {
      if (typeof onclick === 'function' && r && r.id) __gmNotifyHandlers[r.id] = onclick
    })
  }

  function __gmSetClipboard(data: any, info: any): Promise<unknown> {
    const type = typeof info === 'string' ? info : 'text/plain'
    if (type === 'text/html') return __gmSend({ c: 'clipboard.write', html: String(data) })
    return __gmSend({ c: 'clipboard.write', text: String(data) })
  }

  function __gmRegisterMenu(caption: any, onClick: any, options?: any): number {
    const title =
      typeof options === 'object' && options && typeof options.title === 'string'
        ? options.title
        : caption
    const id = __gmMenuKey(caption)
    __gmMenuHandlers[id] = onClick
    __gmEnsureChannel()
    __gmRegSend({ c: 'menu.register', id: id, title: title }).catch(function (e: any) {
      __gmLog('GM_registerMenuCommand 登记失败：' + ((e && e.message) || e))
    })
    return __gmMenuId(caption)
  }
  function __gmUnregisterMenu(idOrCaption: any): void {
    const id =
      typeof idOrCaption === 'number'
        ? 'm-' + ((idOrCaption >>> 0) as number).toString(36)
        : __gmMenuKey(idOrCaption)
    delete __gmMenuHandlers[id]
    __gmRegSend({ c: 'menu.unregister', id: id }).catch(function () {})
  }

  let __gmListenerSeq = 0
  const __gmXhrProgress: Record<string, any> = {}
  function __gmRegisterXhrProgress(requestId: string, fn: any): void {
    __gmXhrProgress[requestId] = fn
  }
  function __gmUnregisterXhrProgress(requestId: string): void {
    delete __gmXhrProgress[requestId]
  }

  const __gmAudioHandlers: Array<any> = []
  let __gmAudioWatching = false
  function __gmAudioSetWatch(want: boolean): void {
    if (want === __gmAudioWatching) return
    __gmAudioWatching = want
    const req = want
      ? { c: 'audio.watch', connId: __gmConnId }
      : { c: 'audio.unwatch', connId: __gmConnId }
    __gmRegSend(req).catch(function (e: any) {
      __gmLog('GM_audio 订阅失败：' + ((e && e.message) || e))
    })
  }
  function __gmAddAudioListener(fn: any): void {
    __gmAudioHandlers.push(fn)
    __gmAudioSetWatch(true)
  }
  function __gmRemoveAudioListener(fn: any): void {
    const i = __gmAudioHandlers.indexOf(fn)
    if (i < 0) return
    __gmAudioHandlers.splice(i, 1)
    if (!__gmAudioHandlers.length) __gmAudioSetWatch(false)
  }
  function __gmFireAudioChange(ev: any): void {
    const list = __gmAudioHandlers.slice()
    for (let i = 0; i < list.length; i++) {
      try {
        list[i](ev)
      } catch (e: any) {
        __gmLog('GM_audio 监听回调异常', e)
      }
    }
  }

  function __gmAddValueChangeListener(key: string, cb: any): number {
    const id = ++__gmListenerSeq
    if (!__gmWatchHandlers[key]) __gmWatchHandlers[key] = []
    __gmWatchHandlers[key].push({ id: id, fn: cb })
    __gmEnsureChannel()
    __gmRegSend({ c: 'store.watch', key: key, connId: __gmConnId }).catch(function (e: any) {
      __gmLog('GM_addValueChangeListener 订阅失败：' + ((e && e.message) || e))
    })
    return id
  }
  function __gmRemoveValueChangeListener(listenerId: number): void {
    for (const key in __gmWatchHandlers) {
      if (!Object.prototype.hasOwnProperty.call(__gmWatchHandlers, key)) continue
      const arr = __gmWatchHandlers[key]
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].id !== listenerId) continue
        arr.splice(i, 1)
        if (!arr.length) {
          delete __gmWatchHandlers[key]
          __gmRegSend({ c: 'store.unwatch', key: key, connId: __gmConnId }).catch(function () {})
        }
        return
      }
    }
  }

  const __gmCookie: any = {
    list: function (details: any, cb?: any) {
      const q = details || {}
      const p = __gmSend({
        c: 'cookie.get',
        url: q.url || location.href,
        name: q.name,
        domain: q.domain,
        path: q.path,
      })
      __gmWithCb(p, cb)
      return p
    },
    set: function (details: any, cb?: any) {
      const d = details || {}
      const p = __gmSend({
        c: 'cookie.set',
        url: d.url || location.href,
        name: d.name,
        value: d.value,
        secure: d.secure,
        httpOnly: d.httpOnly,
        expirationDate: d.expirationDate,
        domain: d.domain,
        path: d.path,
      })
      __gmWithErrCb(p, cb)
      return p
    },
    delete: function (details: any, cb?: any) {
      const d = details || {}
      const p = __gmSend({
        c: 'cookie.remove',
        url: d.url || location.href,
        name: d.name,
        domain: d.domain,
        path: d.path,
      })
      __gmWithErrCb(p, cb)
      return p
    },
  }

  function __gmResource(name: string, wantUrl: boolean): any {
    const r = GM_RESOURCES[name]
    if (!r) {
      __gmLog(
        (wantUrl ? 'GM_getResourceURL' : 'GM_getResourceText') +
          '：资源 ' +
          name +
          ' 不存在（未声明或抓取失败）',
      )
      return undefined
    }
    return wantUrl ? r.url : r.text
  }

  function __gmRunAtBody(fn: () => void): void {
    if (document.body) {
      fn()
      return
    }
    let done = false
    const fire = function () {
      if (done || !document.body) return
      done = true
      if (mo) {
        try {
          mo.disconnect()
        } catch {}
      }
      fn()
    }
    let mo: MutationObserver | null = null
    try {
      mo = new MutationObserver(fire)
      mo.observe(document, { childList: true, subtree: true })
    } catch {
      mo = null
    }
    document.addEventListener('DOMContentLoaded', fire, { once: true })
  }

  const __gmAudioApi: any = {
    setMute: function (details: any, cb?: any) {
      const p = __gmSend({ c: 'audio.setMute', isMuted: !!(details && details.isMuted) })
      if (typeof cb === 'function')
        p.then(
          function () {
            cb()
          },
          function (e: any) {
            cb((e && e.message) || String(e))
          },
        )
      return p
    },
    getState: function (cb?: any) {
      const p = __gmSend({ c: 'audio.getState' }).then(function (s: any) {
        return s || {}
      })
      if (typeof cb === 'function')
        p.then(
          function (s: any) {
            cb(s)
          },
          function (e: any) {
            __gmLog('GM_audio.getState 失败：' + ((e && e.message) || e))
          },
        )
      return p
    },
    addStateChangeListener: function (fn: any, cb?: any) {
      const p = __gmWaitReady().then(function () {
        __gmAddAudioListener(fn)
      })
      if (typeof cb === 'function')
        p.then(
          function () {
            cb()
          },
          function (e: any) {
            cb((e && e.message) || String(e))
          },
        )
      return p
    },
    removeStateChangeListener: function (fn: any, cb?: any) {
      const p = __gmWaitReady().then(function () {
        __gmRemoveAudioListener(fn)
      })
      if (typeof cb === 'function')
        p.then(
          function () {
            cb()
          },
          function (e: any) {
            cb((e && e.message) || String(e))
          },
        )
      return p
    },
  }

  const members: Record<string, unknown> = {}
  members.unsafeWindow = window
  if (GM_HAS.GM_info) members.GM_info = GM_INFO
  if (GM_HAS.GM_getValue)
    members.GM_getValue = function (key: any, def?: any) {
      __gmEnsureChannel()
      return __gmGetSync(key, def)
    }
  if (GM_HAS.GM_listValues)
    members.GM_listValues = function () {
      __gmEnsureChannel()
      return __gmListSync()
    }
  if (GM_HAS.GM_setValue)
    members.GM_setValue = function (key: any, value: any) {
      __gmEnsureChannel()
      __gmSetSync(key, value, false).catch(function () {})
    }
  if (GM_HAS.GM_deleteValue)
    members.GM_deleteValue = function (key: any) {
      __gmEnsureChannel()
      __gmSetSync(key, undefined, true).catch(function () {})
    }
  if (GM_HAS.GM_getValues)
    members.GM_getValues = function (keysOrDefaults: any) {
      __gmEnsureChannel()
      return __gmPickValues(GM_VALUES, keysOrDefaults)
    }
  if (GM_HAS.GM_setValues)
    members.GM_setValues = function (values: any) {
      __gmEnsureChannel()
      __gmSetManySync(values, false).catch(function () {})
    }
  if (GM_HAS.GM_deleteValues)
    members.GM_deleteValues = function (keys: any) {
      __gmEnsureChannel()
      __gmSetManySync(keys, true).catch(function () {})
    }
  if (GM_HAS.GM_addValueChangeListener)
    members.GM_addValueChangeListener = __gmAddValueChangeListener
  if (GM_HAS.GM_removeValueChangeListener)
    members.GM_removeValueChangeListener = __gmRemoveValueChangeListener
  if (GM_HAS.GM_registerMenuCommand) members.GM_registerMenuCommand = __gmRegisterMenu
  if (GM_HAS.GM_unregisterMenuCommand) members.GM_unregisterMenuCommand = __gmUnregisterMenu
  if (GM_HAS.GM_addStyle) members.GM_addStyle = __gmAddStyle
  if (GM_HAS.GM_addElement) members.GM_addElement = __gmAddElement
  if (GM_HAS.GM_log)
    members.GM_log = function () {
      __gmLog.apply(null, arguments as any)
    }
  if (GM_HAS.GM_notification)
    members.GM_notification = function (a: any, b: any, c: any, d: any) {
      __gmNotify(a, b, c, d).catch(function () {})
    }
  if (GM_HAS.GM_setClipboard)
    members.GM_setClipboard = function (data: any, info: any) {
      __gmSetClipboard(data, info).catch(function () {})
    }
  if (GM_HAS.GM_xmlhttpRequest) members.GM_xmlhttpRequest = __gmXhr
  if (GM_HAS.GM_download)
    members.GM_download = function (input: any, name: any) {
      const p: any = __gmDownload(input, name)
      p.catch(function () {})
      return p && typeof p.abort === 'function' ? { abort: p.abort } : { abort: function () {} }
    }
  if (GM_HAS.GM_openInTab) members.GM_openInTab = __gmOpenInTab
  if (GM_HAS.GM_cookie) members.GM_cookie = __gmCookie
  if (GM_HAS.GM_getResourceText)
    members.GM_getResourceText = function (name: any) {
      return __gmResource(name, false)
    }
  if (GM_HAS.GM_getResourceURL)
    members.GM_getResourceURL = function (name: any) {
      return __gmResource(name, true)
    }
  if (GM_HAS.GM_audio) members.GM_audio = __gmAudioApi
  if (GM_HAS.GM_getTab)
    members.GM_getTab = function (cb: any) {
      __gmSend({ c: 'tab.get' }).then(
        function (v: any) {
          if (typeof cb === 'function') cb(v)
        },
        function (e: any) {
          __gmLog('GM_getTab 失败：' + ((e && e.message) || e))
          if (typeof cb === 'function') cb(undefined)
        },
      )
    }
  if (GM_HAS.GM_saveTab)
    members.GM_saveTab = function (tab: any, cb: any) {
      __gmSend({ c: 'tab.save', value: tab }).then(
        function () {
          if (typeof cb === 'function') cb()
        },
        function (e: any) {
          __gmLog('GM_saveTab 失败：' + ((e && e.message) || e))
          if (typeof cb === 'function') cb()
        },
      )
    }
  if (GM_HAS.GM_getTabs)
    members.GM_getTabs = function (cb: any) {
      __gmSend({ c: 'tab.all' }).then(
        function (v: any) {
          if (typeof cb === 'function') cb(v || {})
        },
        function (e: any) {
          __gmLog('GM_getTabs 失败：' + ((e && e.message) || e))
          if (typeof cb === 'function') cb({})
        },
      )
    }

  const GM: any = {}
  if (GM_HAS.info) GM.info = GM_INFO
  if (GM_HAS.getValue)
    GM.getValue = function (key: any, def?: any) {
      __gmEnsureChannel()
      return __gmSend({ c: 'store.get', key: key }).then(function (v: any) {
        if (v === undefined) return def
        GM_VALUES[key] = v
        return v
      })
    }
  if (GM_HAS.listValues)
    GM.listValues = function () {
      return __gmSend({ c: 'store.keys' })
    }
  if (GM_HAS.setValue)
    GM.setValue = function (key: any, value: any) {
      return __gmSetSync(key, value, false)
    }
  if (GM_HAS.deleteValue)
    GM.deleteValue = function (key: any) {
      return __gmSetSync(key, undefined, true)
    }
  if (GM_HAS.getValues)
    GM.getValues = function (keysOrDefaults: any) {
      const want =
        keysOrDefaults == null
          ? null
          : Array.isArray(keysOrDefaults)
            ? keysOrDefaults
            : Object.keys(keysOrDefaults)
      if (want === null) {
        return __gmSend({ c: 'store.all' }).then(function (all: any) {
          return __gmPickValues(all || {}, null)
        })
      }
      return __gmSend({ c: 'store.getMany', keys: want }).then(function (found: any) {
        return __gmPickValues(found || {}, keysOrDefaults)
      })
    }
  if (GM_HAS.setValues)
    GM.setValues = function (values: any) {
      return __gmSetManySync(values, false)
    }
  if (GM_HAS.deleteValues)
    GM.deleteValues = function (keys: any) {
      return __gmSetManySync(keys, true)
    }
  if (GM_HAS.addValueChangeListener)
    GM.addValueChangeListener = function (key: any, cb: any) {
      return Promise.resolve(__gmAddValueChangeListener(key, cb))
    }
  if (GM_HAS.removeValueChangeListener) GM.removeValueChangeListener = __gmRemoveValueChangeListener
  if (GM_HAS.registerMenuCommand)
    GM.registerMenuCommand = function (caption: any, onClick: any, options: any) {
      return __gmWaitReady().then(function () {
        return __gmRegisterMenu(caption, onClick, options)
      })
    }
  if (GM_HAS.unregisterMenuCommand) GM.unregisterMenuCommand = __gmUnregisterMenu
  if (GM_HAS.addStyle) GM.addStyle = __gmAddStyle
  if (GM_HAS.addElement) GM.addElement = __gmAddElement
  if (GM_HAS.log)
    GM.log = function () {
      __gmLog.apply(null, arguments as any)
    }
  if (GM_HAS.notification)
    GM.notification = function (a: any, b: any, c: any) {
      return __gmNotify(a, b, c)
    }
  if (GM_HAS.setClipboard)
    GM.setClipboard = function (data: any, info: any) {
      return __gmSetClipboard(data, info)
    }
  if (GM_HAS.xmlHttpRequest)
    GM.xmlHttpRequest = function (details: any) {
      const d = details || {}
      return new Promise(function (resolve, reject) {
        const opts: any = {}
        for (const k in d) if (Object.prototype.hasOwnProperty.call(d, k)) opts[k] = d[k]
        opts.onload = function (resp: any) {
          resolve(resp)
        }
        opts.onerror = function (resp: any) {
          reject(new Error(resp.error || '请求失败'))
        }
        opts.ontimeout = function () {
          const e: any = new Error('GM.xmlHttpRequest 请求超时')
          e.code = 'BRIDGE_TIMEOUT'
          reject(e)
        }
        __gmXhr(opts)
      })
    }
  if (GM_HAS.download)
    GM.download = function (input: any, name: any) {
      return __gmDownload(input, name)
    }
  if (GM_HAS.openInTab) GM.openInTab = __gmOpenInTab
  if (GM_HAS.getTab)
    GM.getTab = function () {
      return __gmSend({ c: 'tab.get' })
    }
  if (GM_HAS.saveTab)
    GM.saveTab = function (tab: any) {
      return __gmSend({ c: 'tab.save', value: tab })
    }
  if (GM_HAS.getTabs)
    GM.getTabs = function () {
      return __gmSend({ c: 'tab.all' }).then(function (v: any) {
        return v || {}
      })
    }

  if (GM_HAS.getResourceText)
    GM.getResourceText = function (name: any) {
      return Promise.resolve(__gmResource(name, false))
    }
  if (GM_HAS.getResourceUrl)
    GM.getResourceUrl = function (name: any) {
      return Promise.resolve(__gmResource(name, true))
    }
  if (GM_HAS.audio) GM.audio = __gmAudioApi

  try {
    Object.defineProperty(window, 'onurlchange', {
      configurable: true,
      get: function () {
        return __gmUrlChangeHandler
      },
      set: function (fn: any) {
        __gmUrlChangeHandler = typeof fn === 'function' ? fn : null
      },
    })
  } catch {}

  if (GM_HAS['window.close']) {
    try {
      Object.defineProperty(window, 'close', {
        configurable: true,
        writable: true,
        value: function () {
          __gmRegSend({ c: 'tabs.close' }).catch(function (e: any) {
            __gmLog('window.close 失败：' + ((e && e.message) || e))
          })
        },
      })
    } catch (e: any) {
      __gmLog('window.close 挂载失败：' + ((e && e.message) || e))
    }
  }
  if (GM_HAS['window.focus']) {
    try {
      Object.defineProperty(window, 'focus', {
        configurable: true,
        writable: true,
        value: function () {
          __gmRegSend({ c: 'tabs.focus' }).catch(function (e: any) {
            __gmLog('window.focus 失败：' + ((e && e.message) || e))
          })
        },
      })
    } catch (e: any) {
      __gmLog('window.focus 挂载失败：' + ((e && e.message) || e))
    }
  }

  let __gmLastUrl = location.href
  function __gmCheckUrl(): void {
    const cur = location.href
    if (cur === __gmLastUrl) return
    __gmLastUrl = cur
    __gmFireUrlChange(cur)
  }
  try {
    const __gmPushState = history.pushState
    history.pushState = function (this: any) {
      const r = __gmPushState.apply(this, arguments as any)
      setTimeout(__gmCheckUrl, 0)
      return r
    }
    const __gmReplaceState = history.replaceState
    history.replaceState = function (this: any) {
      const r = __gmReplaceState.apply(this, arguments as any)
      setTimeout(__gmCheckUrl, 0)
      return r
    }
  } catch {}
  window.addEventListener('popstate', __gmCheckUrl)
  window.addEventListener('hashchange', __gmCheckUrl)

  function runBody(fn: () => void): void {
    const exec = function () {
      try {
        fn()
      } catch (e: any) {
        __gmReportCaught(e)
      }
    }
    if (env.runAtBody) __gmRunAtBody(exec)
    else exec()
  }

  return { members, runBody }
}
