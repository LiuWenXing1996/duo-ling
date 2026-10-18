// gm-main 注入源 · 通道段（页面世界真源码）。
// 桥请求语义解释（__gmSend）、Port 下行通道底座（连接 / 就绪等待 / 注册请求排队）、
// 菜单 id 派生（djb2）与下行帧分流（port.ready / menu.click / store.change /
// notify.click / audio.change / xhr.progress / download.change）。
//
// 跨段引用（声明在 header / misc 段，同属一个注入作用域）用 declare const 标注 ——
// 类型只活在编译期，esbuild 擦掉声明、保留自由标识符，注入后按名命中同作用域的声明。
// 函数在本模块内「无人调用」是常态（使用方在同作用域的其他段与装配段），
// 故 tsconfig.main.json 对本目录关闭 noUnusedLocals。
declare const __dlBridge: any
declare const __gmRunId: string
declare const GM_VALUES: Record<string, any>
declare const __gmPendingWrites: Record<string, boolean>
declare const NAME_PREFIX: string
declare const __gmLog: (...args: any[]) => void
declare const __gmFireAudioChange: (ev: any) => void
declare const __gmXhrProgress: Record<string, any>
declare const __gmDownloadHandlers: Record<string, any>
declare function __gmUnregisterDownload(id: any): void

// —— 桥请求：超时与传输都归 __dlBridge 管（见 bridge-protocol），这里只解释响应语义 ——
function __gmSend(req: any): Promise<any> {
  // 随请求带上运行标识：SW 据此把这次调用产生的事件 / 桥错误归属到具体某次运行
  return __dlBridge.call(req, __gmRunId).then(function (resp: any) {
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

// —— Port 事件底座：控制面走 sendMessage 请求-响应；Port 只收下行推送帧。
//    控制面请求一律**等 port.ready 之后再发**（见 __gmRegSend）—— 登记一次即成，
//    不需要「重连后把活跃注册补发一遍」：SW 由 offscreen 心跳保活、不会空闲重启，
//    而那条路在首连时只会把在飞的注册重复发一遍。
//    菜单是浏览器级资源，其 id 由标题确定性派生（djb2）——随机 id 会让每次刷新都堆一条菜单。
var __gmConnId = (function () {
  try { return crypto.randomUUID() } catch (e) { return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) }
})()
// 下行通道由中继件代连 Port：本侧只记「是否已请求过连接」与「SW 是否已推 port.ready」
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
  for (var i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) | 0
  return h >>> 0
}
/** 桥侧菜单 id（字符串）：由与 GM_registerMenuCommand 返回值相同的确定性数字派生 */
function __gmMenuKey(caption: any): string { return 'm-' + __gmMenuId(caption).toString(36) }

function __gmFireUrlChange(url: string) {
  var obj = { url: url }
  if (__gmUrlChangeHandler) { try { __gmUrlChangeHandler(obj) } catch (e) { __gmLog('onurlchange 回调异常', e) } }
  // addEventListener('urlchange') 形态：MAIN 世界可以直接派发真实事件——同帧所有脚本都收得到。
  // （隔离世界做不到，那时只能拦 window.addEventListener 做本地转发；那套会覆盖页面的
  //  addEventListener，在 MAIN 世界属于对页面的侵入，故不再用。）
  try { window.dispatchEvent(new CustomEvent('urlchange', { detail: obj })) } catch (e) {}
}

function __gmHandleEvent(ev: any) {
  if (!ev) return
  if (ev.t === 'port.ready') {
    // 下行通道就绪：放行全部等在 __gmWaitReady 上的控制面请求（注册 / 订阅 / 靠帧的命令）
    __gmPortReady = true
    var ws = __gmReadyWaiters.splice(0)
    for (var wi = 0; wi < ws.length; wi++) ws[wi].resolve()
    return
  }
  if (ev.t === 'menu.click') {
    var mh = __gmMenuHandlers[ev.id]
    if (mh) { try { mh() } catch (e) { __gmLog('菜单回调异常', e) } }
  } else if (ev.t === 'store.change') {
    // 远端/本实例写入统一走同一条：先更本地缓存（同步读的下一次调用即拿到新值），再通知监听器
    if (ev.value === null) delete GM_VALUES[ev.key]
    else GM_VALUES[ev.key] = ev.value
    delete __gmPendingWrites[ev.key]
    var cbs = __gmWatchHandlers[ev.key]
    if (cbs) {
      for (var i = 0; i < cbs.length; i++) {
        var entry = cbs[i]
        try { entry.fn(ev.key, ev.oldValue == null ? undefined : ev.oldValue, ev.value == null ? undefined : ev.value, !!ev.remote) } catch (e) { __gmLog('GM_addValueChangeListener 回调异常', e) }
      }
    }
  } else if (ev.t === 'notify.click') {
    var nh = __gmNotifyHandlers[ev.id]
    if (nh) { try { nh() } catch (e) { __gmLog('通知点击回调异常', e) } }
  } else if (ev.t === 'audio.change') {
    // 只把**帧上真有的键**交给脚本：TM 的监听器靠 'muted' in e / 'audible' in e 区分
    // 是静音变化还是发声变化，多塞一个 undefined 键就会破坏这个判据。
    var ae: any = {}
    if ('muted' in ev) ae.muted = ev.muted
    if ('audible' in ev) ae.audible = ev.audible
    __gmFireAudioChange(ae)
  } else if (ev.t === 'xhr.progress') {
    var ph = __gmXhrProgress[ev.requestId]
    if (ph) {
      try { ph({ loaded: ev.loaded, total: ev.total, lengthComputable: ev.total != null }) } catch (e) { __gmLog('onprogress 回调异常', e) }
    }
  } else if (ev.t === 'download.change') {
    var dh = __gmDownloadHandlers[ev.requestId]
    if (dh) {
      if (ev.state === 'progress') {
        if (typeof dh.onprogress === 'function') {
          try { dh.onprogress({ loaded: ev.loaded, total: ev.total, lengthComputable: ev.total != null }) } catch (e) { __gmLog('GM_download onprogress 异常', e) }
        }
      } else {
        // 终帧：先注销再回调（回调里若又发起一次下载，不会被这次的事件污染）
        __gmUnregisterDownload(ev.requestId)
        if (ev.state === 'complete') {
          if (typeof dh.onload === 'function') { try { dh.onload() } catch (e) { __gmLog('GM_download onload 异常', e) } }
        } else if (typeof dh.onerror === 'function') {
          try { dh.onerror({ error: ev.error || 'not_succeeded' }) } catch (e) { __gmLog('GM_download onerror 异常', e) }
        }
      }
    }
  }
}

function __gmConnect() {
  if (__gmConnectStarted) return
  __gmConnectStarted = true
  // 中继件代连 Port；接通后 SW 推 port.ready，经桥回到 __gmHandleEvent
  __dlBridge.connect(__gmConnId).catch(function (e: any) {
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
  return __gmWaitReady().then(function () { return __gmSend(req) })
}

/**
 * 「回调靠下行帧」的命令（xhr 的 onprogress、GM_download 的 onprogress / onload / onerror）必须先
 * 等通道就绪 —— 帧是从 Port 推的，而 __gmSend 只管请求-应答、**不建通道**。不等的话：SW 侧
 * portsByConnId 命中 0 个连接，每一帧都被丢掉，而请求本身照常成功，脚本侧表现为「回调永不触发」。
 *
 * 通道建立失败**不阻断命令**：请求 / 下载本身是主体、回调是附加，宁可降级也不让它们发不出去；
 * 但要在控制台喊一声，别变成新的静默失败。
 */
function __gmSendAfterChannel(req: any): Promise<any> {
  if (__gmPortReady) return __gmSend(req)
  return __gmWaitReady()
    .catch(function (e) {
      console.warn(NAME_PREFIX + ' 下行通道未就绪，本次调用的进度 / 完成回调会收不到：' + ((e && e.message) || e))
    })
    .then(function () { return __gmSend(req) })
}
