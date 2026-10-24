declare const GM_HAS: any
declare const GM_INFO: any
declare const GM_VALUES: Record<string, any>
declare const __gmEnsureChannel: () => Promise<void>
declare const __gmGetSync: (key: string, def: any) => any
declare const __gmListSync: () => string[]
declare const __gmSetSync: (key: string, value: any, isDelete: boolean) => Promise<any>
declare const __gmPickValues: (source: any, keysOrDefaults: any) => Record<string, any>
declare const __gmSetManySync: (input: any, isDelete: boolean) => Promise<any>
declare const __gmAddValueChangeListener: (key: string, cb: any) => number
declare const __gmRemoveValueChangeListener: (listenerId: number) => void
declare const __gmRegisterMenu: (caption: string, onClick: any, options?: any) => number
declare const __gmUnregisterMenu: (idOrCaption: any) => void
declare const __gmAddStyle: (css: string) => HTMLElement
declare const __gmAddElement: (a: any, b?: any, c?: any) => HTMLElement
declare const __gmLog: (...args: any[]) => void
declare const __gmNotify: (a?: any, b?: any, c?: any, d?: any) => Promise<any>
declare const __gmSetClipboard: (data: any, info?: any) => Promise<any>
declare const __gmXhr: (details: any) => any
declare const __gmDownload: (input: any, name?: any) => Promise<any>
declare const __gmOpenInTab: (url: string, options?: any) => any
declare const __gmCookie: any
declare const __gmResource: (name: string, wantUrl: any) => any
declare const __gmAudioApi: any
declare const __gmSend: (req: any) => Promise<any>
declare const __gmWaitReady: () => Promise<void>
declare const __gmRegSend: (req: any) => Promise<any>
declare var __gmUrlChangeHandler: ((url: any) => void) | null
declare const __gmFireUrlChange: (url: string) => void
declare function __gmBodyOpen(): void

var GM_info: any,
  GM_getValue: any,
  GM_listValues: any,
  GM_setValue: any,
  GM_deleteValue: any,
  GM_getValues: any,
  GM_setValues: any,
  GM_deleteValues: any,
  GM_addValueChangeListener: any,
  GM_removeValueChangeListener: any,
  GM_registerMenuCommand: any,
  GM_unregisterMenuCommand: any,
  GM_addStyle: any,
  GM_addElement: any,
  GM_log: any,
  GM_notification: any,
  GM_setClipboard: any,
  GM_xmlhttpRequest: any,
  GM_download: any,
  GM_openInTab: any,
  GM_cookie: any,
  GM_audio: any,
  GM_getResourceText: any,
  GM_getResourceURL: any,
  GM_getTab: any,
  GM_saveTab: any,
  GM_getTabs: any
if (GM_HAS.GM_info) GM_info = GM_INFO
if (GM_HAS.GM_getValue)
  GM_getValue = function (key: any, def: any) {
    __gmEnsureChannel()
    return __gmGetSync(key, def)
  }
if (GM_HAS.GM_listValues)
  GM_listValues = function () {
    __gmEnsureChannel()
    return __gmListSync()
  }
if (GM_HAS.GM_setValue)
  GM_setValue = function (key: any, value: any) {
    __gmEnsureChannel()
    __gmSetSync(key, value, false).catch(function () {})
  }
if (GM_HAS.GM_deleteValue)
  GM_deleteValue = function (key: any) {
    __gmEnsureChannel()
    __gmSetSync(key, undefined, true).catch(function () {})
  }
if (GM_HAS.GM_getValues)
  GM_getValues = function (keysOrDefaults: any) {
    __gmEnsureChannel()
    return __gmPickValues(GM_VALUES, keysOrDefaults)
  }
if (GM_HAS.GM_setValues)
  GM_setValues = function (values: any) {
    __gmEnsureChannel()
    __gmSetManySync(values, false).catch(function () {})
  }
if (GM_HAS.GM_deleteValues)
  GM_deleteValues = function (keys: any) {
    __gmEnsureChannel()
    __gmSetManySync(keys, true).catch(function () {})
  }
if (GM_HAS.GM_addValueChangeListener) GM_addValueChangeListener = __gmAddValueChangeListener
if (GM_HAS.GM_removeValueChangeListener)
  GM_removeValueChangeListener = __gmRemoveValueChangeListener
if (GM_HAS.GM_registerMenuCommand) GM_registerMenuCommand = __gmRegisterMenu
if (GM_HAS.GM_unregisterMenuCommand) GM_unregisterMenuCommand = __gmUnregisterMenu
if (GM_HAS.GM_addStyle) GM_addStyle = __gmAddStyle
if (GM_HAS.GM_addElement) GM_addElement = __gmAddElement
if (GM_HAS.GM_log)
  GM_log = function () {
    __gmLog.apply(null, arguments as any)
  }
if (GM_HAS.GM_notification)
  GM_notification = function (a: any, b: any, c: any, d: any) {
    __gmNotify(a, b, c, d).catch(function () {})
  }
if (GM_HAS.GM_setClipboard)
  GM_setClipboard = function (data: any, info: any) {
    __gmSetClipboard(data, info).catch(function () {})
  }
if (GM_HAS.GM_xmlhttpRequest) GM_xmlhttpRequest = __gmXhr
if (GM_HAS.GM_download)
  GM_download = function (input: any, name: any) {
    var p: any = __gmDownload(input, name)
    p.catch(function () {}) // 失败已走 onerror，这里只防 unhandled rejection
    return p && typeof p.abort === 'function' ? { abort: p.abort } : { abort: function () {} }
  }
if (GM_HAS.GM_openInTab) GM_openInTab = __gmOpenInTab
if (GM_HAS.GM_cookie) GM_cookie = __gmCookie
if (GM_HAS.GM_getResourceText)
  GM_getResourceText = function (name: any) {
    return __gmResource(name, false)
  }
if (GM_HAS.GM_getResourceURL)
  GM_getResourceURL = function (name: any) {
    return __gmResource(name, true)
  }
if (GM_HAS.GM_audio) GM_audio = __gmAudioApi
if (GM_HAS.GM_getTab)
  GM_getTab = function (cb: any) {
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
  GM_saveTab = function (tab: any, cb: any) {
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
  GM_getTabs = function (cb: any) {
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

var GM: any = {}
if (GM_HAS.info) GM.info = GM_INFO
if (GM_HAS.getValue)
  GM.getValue = function (key: any, def: any) {
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
    var want =
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
    var d = details || {}
    return new Promise(function (resolve: any, reject: any) {
      var opts: any = {}
      for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) opts[k] = d[k]
      opts.onload = function (resp: any) {
        resolve(resp)
      }
      opts.onerror = function (resp: any) {
        reject(new Error(resp.error || '请求失败'))
      }
      opts.ontimeout = function () {
        var e: any = new Error('GM.xmlHttpRequest 请求超时')
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

var unsafeWindow = window

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
} catch (e) {}

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
  } catch (e) {
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
  } catch (e) {
    __gmLog('window.focus 挂载失败：' + ((e && e.message) || e))
  }
}

var __gmLastUrl = location.href
function __gmCheckUrl() {
  var cur = location.href
  if (cur === __gmLastUrl) return
  __gmLastUrl = cur
  __gmFireUrlChange(cur)
}
try {
  var __gmPushState = history.pushState
  history.pushState = function () {
    var r = __gmPushState.apply(this, arguments as any)
    setTimeout(__gmCheckUrl, 0)
    return r
  }
  var __gmReplaceState = history.replaceState
  history.replaceState = function () {
    var r = __gmReplaceState.apply(this, arguments as any)
    setTimeout(__gmCheckUrl, 0)
    return r
  }
} catch (e) {}
window.addEventListener('popstate', __gmCheckUrl)
window.addEventListener('hashchange', __gmCheckUrl)

__gmBodyOpen()
