declare const __gmBridge: any
declare const __gmRunId: string
declare const GM_VALUES: Record<string, any>
declare const __gmPendingWrites: Record<string, boolean>
declare const NAME_PREFIX: string
declare const __gmLog: (...args: any[]) => void
declare const __gmFireAudioChange: (ev: any) => void
declare const __gmXhrProgress: Record<string, any>
declare const __gmDownloadHandlers: Record<string, any>
declare function __gmUnregisterDownload(id: any): void

function __gmSend(req: any): Promise<any> {
  return __gmBridge.call(req, __gmRunId).then(function (resp: any) {
    if (!resp) {
      var e: any = new Error('GM 调用无响应：' + (req && req.c))
      e.code = 'BRIDGE_NO_RESPONSE'
      throw e
    }
    if (!resp.ok) {
      var e2: any = new Error(resp.error || 'GM 调用失败')
      if (resp.code) e2.code = resp.code
      throw e2
    }
    return resp.data
  })
}

var __gmConnId = (function () {
  try {
    return crypto.randomUUID()
  } catch (e) {
    return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  }
})()
var __gmConnectStarted = false
var __gmPortReady = false
var __gmReadyWaiters: any[] = []
var __gmMenuHandlers: Record<string, any> = {}
var __gmWatchHandlers: Record<string, any> = {}
var __gmNotifyHandlers: Record<string, any> = {}
var __gmUrlChangeHandler: ((url: any) => void) | null = null

function __gmMenuId(caption: any): number {
  var h = 5381
  var s = String(caption || 'menu')
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return h >>> 0
}
function __gmMenuKey(caption: any): string {
  return 'm-' + __gmMenuId(caption).toString(36)
}

function __gmFireUrlChange(url: string) {
  var obj = { url: url }
  if (__gmUrlChangeHandler) {
    try {
      __gmUrlChangeHandler(obj)
    } catch (e) {
      __gmLog('onurlchange 回调异常', e)
    }
  }
  try {
    window.dispatchEvent(new CustomEvent('urlchange', { detail: obj }))
  } catch (e) {}
}

function __gmHandleEvent(ev: any) {
  if (!ev) return
  if (ev.t === 'port.ready') {
    __gmPortReady = true
    var ws = __gmReadyWaiters.splice(0)
    for (var wi = 0; wi < ws.length; wi++) ws[wi].resolve()
    return
  }
  if (ev.t === 'menu.click') {
    var mh = __gmMenuHandlers[ev.id]
    if (mh) {
      try {
        mh()
      } catch (e) {
        __gmLog('菜单回调异常', e)
      }
    }
  } else if (ev.t === 'store.change') {
    if (ev.value === null) delete GM_VALUES[ev.key]
    else GM_VALUES[ev.key] = ev.value
    delete __gmPendingWrites[ev.key]
    var cbs = __gmWatchHandlers[ev.key]
    if (cbs) {
      for (var i = 0; i < cbs.length; i++) {
        var entry = cbs[i]
        try {
          entry.fn(
            ev.key,
            ev.oldValue == null ? undefined : ev.oldValue,
            ev.value == null ? undefined : ev.value,
            !!ev.remote,
          )
        } catch (e) {
          __gmLog('GM_addValueChangeListener 回调异常', e)
        }
      }
    }
  } else if (ev.t === 'notify.click') {
    var nh = __gmNotifyHandlers[ev.id]
    if (nh) {
      try {
        nh()
      } catch (e) {
        __gmLog('通知点击回调异常', e)
      }
    }
  } else if (ev.t === 'audio.change') {
    var ae: any = {}
    if ('muted' in ev) ae.muted = ev.muted
    if ('audible' in ev) ae.audible = ev.audible
    __gmFireAudioChange(ae)
  } else if (ev.t === 'xhr.progress') {
    var ph = __gmXhrProgress[ev.requestId]
    if (ph) {
      try {
        ph({ loaded: ev.loaded, total: ev.total, lengthComputable: ev.total != null })
      } catch (e) {
        __gmLog('onprogress 回调异常', e)
      }
    }
  } else if (ev.t === 'download.change') {
    var dh = __gmDownloadHandlers[ev.requestId]
    if (dh) {
      if (ev.state === 'progress') {
        if (typeof dh.onprogress === 'function') {
          try {
            dh.onprogress({
              loaded: ev.loaded,
              total: ev.total,
              lengthComputable: ev.total != null,
            })
          } catch (e) {
            __gmLog('GM_download onprogress 异常', e)
          }
        }
      } else {
        __gmUnregisterDownload(ev.requestId)
        if (ev.state === 'complete') {
          if (typeof dh.onload === 'function') {
            try {
              dh.onload()
            } catch (e) {
              __gmLog('GM_download onload 异常', e)
            }
          }
        } else if (typeof dh.onerror === 'function') {
          try {
            dh.onerror({ error: ev.error || 'not_succeeded' })
          } catch (e) {
            __gmLog('GM_download onerror 异常', e)
          }
        }
      }
    }
  }
}

function __gmConnect() {
  if (__gmConnectStarted) return
  __gmConnectStarted = true
  __gmBridge.connect(__gmConnId).catch(function (e: any) {
    __gmConnectStarted = false // 握手失败（中继件未就位）：允许后续调用重试
    console.warn(NAME_PREFIX + ' 事件通道连接失败：' + ((e && e.message) || e))
  })
}

function __gmWaitReady(): Promise<void> {
  if (__gmPortReady) return Promise.resolve()
  __gmConnect()
  return new Promise<void>(function (resolve, reject) {
    var done = false
    var timer = setTimeout(function () {
      if (done) return
      done = true
      var i = __gmReadyWaiters.indexOf(w)
      if (i >= 0) __gmReadyWaiters.splice(i, 1)
      reject(new Error('GM 事件通道连接超时（8s 未就绪）'))
    }, 8000)
    var w = {
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
    .catch(function (e) {
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
