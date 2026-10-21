// gm-main 注入源 · 装配段（页面世界真源码）。
// 按 GM_HAS 裁剪挂载 GM_* 全局与 GM.* 命名空间两套形态、unsafeWindow / onurlchange /
// window.close / window.focus 挂载、URL 变化本地检测（history hook），最后打开
// 正文 try 块（闭合在后缀，见 ../index.ts 的 GM_WRAPPER_SUFFIX）。
// 「—— 组装成员」注释是 gm-api-catalog 防漂移测试的反射锚点，勿改写。
// 跨段引用的 declare const 约定见 channel.ts 文件头。
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
// 正文闸门哨兵：esbuild 吐不出未闭合的 try 块，源码以本调用占位，
// 构建时替换成真正的 `try {`（见 build.mjs 的 gm-main 段）
declare function __gmBodyOpen(): void

// —— 组装成员（按 @grant 裁剪：GM_HAS 由注册侧算好）——
// 全部声明为**局部变量**而非挂 window：同帧多脚本共享一个 window，挂上去会互相覆盖；
// 而脚本与本包装拼在同一条 code 里（同一函数作用域），按词法即可拿到（见文件头说明）。
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
// 批量版（同步形态）：读本地镜像、写一条批量命令，语义见 __gmPickValues / __gmSetManySync
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
    // TM 形态：回调式返回 { abort() }。Blob / ArrayBuffer 走本地锚点、不经扩展，没有可中止的对象
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

// —— 组装 GM.* 命名空间（Promise 形态；读走桥＝永远新鲜，写先更缓存）——
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
// 批量版（异步形态）：读走桥＝**服务端最新**（与 GM.getValue 同口径，不只本地快照）；
// 只取请求的键（store.getMany），不像 store.all 那样把整份存储搬过桥。
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

// 资源取值（TM 的 GM.* 形态是 **getResourceText / getResourceUrl** —— Url 的小写 r/l 与全局名不同，
// 这里刻意照抄 TM，不统一大小写；虽然本该同步，但 GM.* 一律 Promise 形态）
if (GM_HAS.getResourceText)
  GM.getResourceText = function (name: any) {
    return Promise.resolve(__gmResource(name, false))
  }
if (GM_HAS.getResourceUrl)
  GM.getResourceUrl = function (name: any) {
    return Promise.resolve(__gmResource(name, true))
  }

// GM.audio：与全局 GM_audio 是同一套方法（本来都返回 Promise），直接复用同一对象，不另写一份
if (GM_HAS.audio) GM.audio = __gmAudioApi

// —— unsafeWindow：脚本跑在页面 MAIN 世界，这里就是页面自己的 window ——
//    直接指向 window 即可（隔离世界下才需要一个别名），无需访问告警。
var unsafeWindow = window

// —— window.onurlchange（TM 形态）：属性赋值 + addEventListener('urlchange') 两种都给。
//    监听器拦在本地、不派发真实事件（派发会经共享的 window 事件目标泄漏给页面）。——
try {
  Object.defineProperty(window, 'onurlchange', {
    configurable: true,
    get: function () {
      return __gmUrlChangeHandler
    },
    // 纯本地：只记下回调，URL 检测（见文件末尾的 history hook）负责调它，不经 SW 订阅
    set: function (fn: any) {
      __gmUrlChangeHandler = typeof fn === 'function' ? fn : null
    },
  })
} catch (e) {}

// —— window.close / window.focus（TM 把「关 / 聚焦当前标签页」也当 @grant 项）。
//    挂到 window 上是安全的：本扩展跑在隔离的 USER_SCRIPT 世界，改的不是页面的 window；
//    同世界多脚本共享这两个成员，但它们都只是无状态转发，互相覆盖无害。
//    window.close 的失败（例如「窗口的最后一个标签页」）只记日志 —— 与原生一样是同步无返回，
//    调用方拿不到错误，写 __gmLog 是为了让它别静默消失。——
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

// —— URL 变化：MAIN 世界直接本地检测（hook history + popstate / hashchange）。
//    不再经 SW 推：脚本与页面同处一个世界，自己能听见路由变化——省一条跨世界通道，
//    也避免了「拦 window.addEventListener 做本地转发」那套对页面热路径方法的覆盖。——
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
} catch (e) {
  /* 极少数环境改不动 history：退化为只看 popstate / hashchange */
}
window.addEventListener('popstate', __gmCheckUrl)
// 必须带分号：脚本正文以 ( 开头时会被 ASI 并进本句（真机踩过，parse 测试抓不住）
window.addEventListener('hashchange', __gmCheckUrl)

// —— 正文执行区：自此行到闭合后缀的 catch，中间全部是脚本正文（含 @require）。
//    整体包 try 是同步错误归属的前提（口径见 header 段的错误收集段）；包装层成员、事件监听
//    与 runId 广播都在 try 之前就位，正文抛错不影响它们。——
__gmBodyOpen()
