declare const __gmSend: (req: any) => Promise<any>
declare const __gmSendAfterChannel: (req: any) => Promise<any>
declare const __gmRegSend: (req: any) => Promise<any>
declare const __gmWaitReady: () => Promise<void>
declare const __gmEnsureChannel: () => Promise<void>
declare const __gmMenuKey: (caption: any) => string
declare const __gmMenuId: (caption: any) => number
declare const __gmMenuHandlers: Record<string, any>
declare const __gmNotifyHandlers: Record<string, any>
declare const __gmWatchHandlers: Record<string, any>
declare const __gmConnId: string
declare const __gmLog: (...args: any[]) => void
declare const __gmTriggerAnchor: (href: string, name?: string) => void
declare const __gmWithCb: (p: any, cb: any) => void
declare const __gmWithErrCb: (p: any, cb: any) => void
declare const GM_RESOURCES: Record<string, { text: string; url: string }>

var __gmDownloadHandlers: Record<string, any> = {}
var __gmDownloadSeq = 0
function __gmUnregisterDownload(id: any) {
  delete __gmDownloadHandlers[id]
}

function __gmDownloadUrl(d: any) {
  var wantsProgress = typeof d.onprogress === 'function'
  var wantsFrames =
    wantsProgress || typeof d.onload === 'function' || typeof d.onerror === 'function'
  var requestId = '__gmDl' + ++__gmDownloadSeq
  if (wantsFrames) __gmDownloadHandlers[requestId] = d
  var downloadId: number | null = null
  var abortEarly = false
  function __gmAbortDownload() {
    if (typeof downloadId === 'number') {
      __gmSend({ c: 'download.cancel', id: downloadId }).catch(function () {})
    } else {
      abortEarly = true
    }
  }
  var sendReq = wantsFrames ? __gmSendAfterChannel : __gmSend
  var p: any = sendReq({
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
      if (abortEarly) __gmAbortDownload()
      return r
    },
    function (e: any) {
      __gmUnregisterDownload(requestId)
      if (typeof d.onerror === 'function') {
        try {
          d.onerror({ error: (e && e.message) || 'not_succeeded' })
        } catch (_) {}
      }
      throw e
    },
  )
  p.abort = __gmAbortDownload
  return p
}

function __gmDownload(input: any, name?: any): Promise<any> {
  if (typeof input === 'string') return __gmDownloadUrl({ url: input, name: name })
  if (input && typeof input === 'object' && typeof input.url === 'string')
    return __gmDownloadUrl(input)
  var blob: Blob | null = null
  if (typeof Blob !== 'undefined' && input instanceof Blob) blob = input
  else if (input instanceof ArrayBuffer) blob = new Blob([input])
  else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(input))
    blob = new Blob([new Uint8Array((input as any).buffer, input.byteOffset, input.byteLength)])
  if (!blob)
    return Promise.reject(
      new Error(
        'GM_download：首参仅支持 URL 字符串 / details 对象 / Blob / ArrayBuffer / TypedArray',
      ),
    )
  var url = URL.createObjectURL(blob)
  try {
    __gmTriggerAnchor(url, name)
  } finally {
    setTimeout(function () {
      URL.revokeObjectURL(url)
    }, 1000)
  }
  return Promise.resolve()
}

function __gmOpenInTab(url: string, options?: any) {
  var active = true
  if (typeof options === 'boolean') active = options
  else if (options && typeof options === 'object' && typeof options.active === 'boolean')
    active = options.active
  var tabId: any = null
  var pendingClose = false
  var handle = {
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

function __gmNotify(a?: any, b?: any, c?: any, d?: any): Promise<any> {
  var msg: any, title: any, icon: any, onclick: any
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
  var sendReq = typeof onclick === 'function' ? __gmSendAfterChannel : __gmSend
  return sendReq({
    c: 'notify',
    message: String(msg == null ? '' : msg),
    title: title,
    icon: icon,
  }).then(function (r: any) {
    if (typeof onclick === 'function' && r && r.id) __gmNotifyHandlers[r.id] = onclick
  })
}

function __gmSetClipboard(data: any, info?: any): Promise<any> {
  var type = typeof info === 'string' ? info : 'text/plain'
  if (type === 'text/html') return __gmSend({ c: 'clipboard.write', html: String(data) })
  return __gmSend({ c: 'clipboard.write', text: String(data) })
}

function __gmRegisterMenu(caption: string, onClick: any, options?: any): number {
  var title =
    typeof options === 'object' && options && typeof options.title === 'string'
      ? options.title
      : caption
  var id = __gmMenuKey(caption)
  __gmMenuHandlers[id] = onClick
  __gmEnsureChannel()
  __gmRegSend({ c: 'menu.register', id: id, title: title }).catch(function (e: any) {
    __gmLog('GM_registerMenuCommand 登记失败：' + ((e && e.message) || e))
  })
  return __gmMenuId(caption)
}
function __gmUnregisterMenu(idOrCaption: any) {
  var id =
    typeof idOrCaption === 'number'
      ? 'm-' + (idOrCaption >>> 0).toString(36)
      : __gmMenuKey(idOrCaption)
  delete __gmMenuHandlers[id]
  __gmRegSend({ c: 'menu.unregister', id: id }).catch(function () {})
}

var __gmListenerSeq = 0
var __gmXhrProgress: Record<string, any> = {}
function __gmRegisterXhrProgress(requestId: string, fn: any) {
  __gmXhrProgress[requestId] = fn
}
function __gmUnregisterXhrProgress(requestId: string) {
  delete __gmXhrProgress[requestId]
}

var __gmAudioHandlers: any[] = []
var __gmAudioWatching = false
function __gmAudioSetWatch(want: boolean) {
  if (want === __gmAudioWatching) return
  __gmAudioWatching = want
  var req = want
    ? { c: 'audio.watch', connId: __gmConnId }
    : { c: 'audio.unwatch', connId: __gmConnId }
  __gmRegSend(req).catch(function (e: any) {
    __gmLog('GM_audio 订阅失败：' + ((e && e.message) || e))
  })
}
function __gmAddAudioListener(fn: any) {
  __gmAudioHandlers.push(fn)
  __gmAudioSetWatch(true)
}
function __gmRemoveAudioListener(fn: any) {
  var i = __gmAudioHandlers.indexOf(fn)
  if (i < 0) return
  __gmAudioHandlers.splice(i, 1)
  if (!__gmAudioHandlers.length) __gmAudioSetWatch(false)
}
function __gmFireAudioChange(ev: any) {
  var list = __gmAudioHandlers.slice()
  for (var i = 0; i < list.length; i++) {
    try {
      list[i](ev)
    } catch (e) {
      __gmLog('GM_audio 监听回调异常', e)
    }
  }
}

function __gmAddValueChangeListener(key: string, cb: any): number {
  var id = ++__gmListenerSeq
  if (!__gmWatchHandlers[key]) __gmWatchHandlers[key] = []
  __gmWatchHandlers[key].push({ id: id, fn: cb })
  __gmEnsureChannel()
  __gmRegSend({ c: 'store.watch', key: key, connId: __gmConnId }).catch(function (e: any) {
    __gmLog('GM_addValueChangeListener 订阅失败：' + ((e && e.message) || e))
  })
  return id
}
function __gmRemoveValueChangeListener(listenerId: number) {
  for (var key in __gmWatchHandlers) {
    if (!Object.prototype.hasOwnProperty.call(__gmWatchHandlers, key)) continue
    var arr = __gmWatchHandlers[key]
    for (var i = 0; i < arr.length; i++) {
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
var __gmCookie = {
  list: function (details: any, cb?: any) {
    var q = details || {}
    var p = __gmSend({
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
    var d = details || {}
    var p = __gmSend({
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
    var d = details || {}
    var p = __gmSend({
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

function __gmResource(name: string, wantUrl: any) {
  var r = GM_RESOURCES[name]
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

function __gmRunAtBody(fn: () => void) {
  if (document.body) {
    fn()
    return
  }
  var done = false
  var fire = function () {
    if (done || !document.body) return
    done = true
    if (mo) {
      try {
        mo.disconnect()
      } catch (e) {}
    }
    fn()
  }
  var mo: MutationObserver | null = null
  try {
    mo = new MutationObserver(fire)
    mo.observe(document, { childList: true, subtree: true })
  } catch (e) {
    mo = null
  }
  document.addEventListener('DOMContentLoaded', fire, { once: true })
}

var __gmAudioApi = {
  setMute: function (details: any, cb?: any) {
    var p = __gmSend({ c: 'audio.setMute', isMuted: !!(details && details.isMuted) })
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
    var p = __gmSend({ c: 'audio.getState' }).then(function (s: any) {
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
    var p = __gmWaitReady().then(function () {
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
    var p = __gmWaitReady().then(function () {
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
