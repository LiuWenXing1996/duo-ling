// gm-main 注入源 · 杂项能力段（页面世界真源码）。
// GM_download（浏览器下载器 + 本地锚点）、openInTab、notification、setClipboard、
// 菜单登记、xhr 进度登记表、音频监听与值变更监听、cookie、@resource 取值、
// document-body 闸门与 GM_audio API。
// 跨段引用的 declare const 约定见 channel.ts 文件头。
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

// —— GM_download：URL / details 走**浏览器下载器**（chrome.downloads），结局经 Port 回来 ——
//    不再自己 fetch 的理由：只有浏览器下载器能弹「另存为」（saveAs），而且它流式落盘 ——
//    自己 fetch 再转 base64、经 data URL 点锚点，要把整份文件读进内存，大文件会炸。
//    Blob / ArrayBuffer 入参仍在本地走锚点（二进制没必要往返一趟扩展）。
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
  // abort：id 到手前调用就记为「待中止」，id 一到立刻 cancel（不放过这个竞态窗口）
  var downloadId: number | null = null
  var abortEarly = false
  function __gmAbortDownload() {
    if (typeof downloadId === 'number') {
      // **不在这里注销处理器**：cancel 后 SW 会推 interrupted 终帧，onerror（TM 语义：取消也算
      // onerror）靠它送达；终帧处理自己会注销（一次性）。提前删 = onerror 永不触发，调用方挂死。
      __gmSend({ c: 'download.cancel', id: downloadId }).catch(function () {})
    } else {
      abortEarly = true
    }
  }
  // 要帧（progress / load / error）→ 先等通道，否则 SW 侧找不到连接、帧全丢
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
      // 起不来（扩展没 downloads 权限 / URL 非法 / 文件名非法）：立即回报并清掉登记
      __gmUnregisterDownload(requestId)
      if (typeof d.onerror === 'function') {
        try {
          d.onerror({ error: (e && e.message) || 'not_succeeded' })
        } catch (_) {}
      }
      throw e
    },
  )
  // abort 挂在 Promise 上：GM.download 直接返回它（TM 同为「promise 也带 abort」）
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
  // 带 onclick 的通知：点击回调靠 Port 推帧（SW 按 uuid 找连接），同样要先等通道
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
// —— 请求进度登记（GM_xmlhttpRequest 的 onprogress）——
// 进度帧按 requestId 回来，这张表记住"哪个 requestId 要回调哪个函数"。请求结束（成功 / 失败 /
// 中止）都要清 —— 否则脚本跑久了表只增不减。
var __gmXhrProgress: Record<string, any> = {}
function __gmRegisterXhrProgress(requestId: string, fn: any) {
  __gmXhrProgress[requestId] = fn
}
function __gmUnregisterXhrProgress(requestId: string) {
  delete __gmXhrProgress[requestId]
}

// —— 音频状态监听（GM_audio.addStateChangeListener）——
// TM 用**函数引用**标识监听器（没有 id 机制）：本地就是一张函数数组，由空变非空时订阅、
// 非空变空时退订 —— 与值监听同款「按需订阅」，没有监听就不收 audio.change 帧。
var __gmAudioHandlers: any[] = []
var __gmAudioWatching = false
function __gmAudioSetWatch(want: boolean) {
  if (want === __gmAudioWatching) return
  __gmAudioWatching = want
  // 命令名写成两个字面量（不要用三元拼字符串）—— 契约一致性单测按**字面量**反射
  // 「哪条命令由谁发出」，拼出来的名字它看不见，会被判成「没人发的死命令」。
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
// 三个方法都照 TM 收 domain / path：url 恒参与查询（缺省当前页），domain / path 只是**收窄条件**，
// 桥侧按 AND 语义交给 chrome.cookies —— 边界由域名门 + 浏览器自身保证（见 cookie-gate.ts）。
// 故这里不留「遇到不支持的字段就显式拒绝」那层：三个方法的 domain / path 都按条件交给桥。
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

// —— @resource 取值（TM：文本 / base64 data URI，都是**同步**返回）——
//    取不到（未声明该名、或抓取失败）返回 undefined 并记一条日志：报错会把脚本整段带崩，
//    而 TM 这类「拿不到素材」的情形脚本自己判 undefined 更常见。
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

// —— @run-at document-body 的闸门：body 出现后才执行正文 ——
//    Chrome 的 userScripts.runAt 只有 start / end / idle，没有 body，故注入用 document_start +
//    闸门把**正文**推后。包装层自身（GM 成员挂载、Port 连接、事件监听）不等 —— 它不碰页面 DOM，
//    早跑没有副作用，而等它会白白推迟脚本能调 GM API 的时点。
//    两条触发路径都挂上并各自幂等：MutationObserver 抓 body 插入，DOMContentLoaded 兜底。
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

// —— 音频控制（TM v5.0+）：4 个成员都作用于**当前标签页**。回调可省 → 返回 Promise
//    （TM 里 getState 的回调是必需的，这里放宽；回调形状照 TM：getState 回状态对象，其余回 error）——
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
  // 订阅登记交给 __gmAddAudioListener：它管「表由空变非空才订阅」的那层节流
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
