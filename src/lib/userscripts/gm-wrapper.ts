// GM 包装源码模板（注入到**页面 MAIN 世界**，先于脚本源码定义 `GM_*` / `GM.*`）。
//
// 为什么独立成文件（而不是塞回 engine.ts）：
//   · 它是**注入到页面里的源码字符串**，语法错一次就静默全废，值得单文件可读可审；
//   · 速查页（gm-api-catalog）的防漂移单测要从**源码反射**出真实挂载的键集合，
//     反射锚点落在本文件比落在 engine 的注册链路里稳（engine 会 import IDB / chrome API）。
//
// **与脚本源码同处一个函数作用域**：engine 把「本包装（未闭合）＋ `@require` ＋ 脚本源码 ＋
// 闭合后缀」拼成**一条** code 注入。为什么必须这样：
//   · MAIN 世界不支持 `worldId`，同帧多脚本共享一个 `window` —— 若把 `GM_*` 挂到 window 上，
//     后注入的脚本会把前一个的成员整个覆盖；
//   · 故全部成员**声明为局部变量**，脚本按词法作用域找到它们；`unsafeWindow` 于是就是本世界
//     的 `window`，不再需要别名与降级告警；
//   · 副作用：脚本顶层 `var` 不再进页面全局（要挂页面请用 `unsafeWindow`）。
//
// 设计要点：
//   · **无 `chrome.*`**：MAIN 世界没有扩展 API，一切经同帧中继件转 SW（`__dlBridge`，见 script-bridge.ts）。
//   · **同步读**：`GM_getValue` / `GM_listValues` 必须同步（油猴语义），故注册时把该脚本的
//     全量值作为**快照**嵌进注入体（`GM_VALUES`），同步读走内存；写则「先更本地缓存、再异步过桥」
//     （对齐 Violentmonkey `dumpValue()`：本地先落、`UpdateValue` 后发）。
//   · **常驻通道**：只读值的脚本原本从不 connect（`store.get/set` 是一次性请求），
//     于是别的标签页改了值它永远收不到 → 同步快照会**长周期陈旧**。故「读过值」也触发 connect，
//     并补 `store.watchAll`（全量订阅）与 connect 后的**一次全量校准**（覆盖就绪前的窗口）。
//   · **`@grant` 裁剪**：只有写进清单的能力才注入；不写 `@grant` / `@grant none` → 只给恒注入集。
//   · **降级项**（速查页与 spec 必须标注）：`GM_xmlhttpRequest` 的 `responseType` 不支持 `stream`；
//     它的 `onprogress` 只给进度字段（不带完整 response）；`GM_cookie` 的 `list` / `delete`
//     不收 `domain` / `path` 查询（`set` 已支持）。
import { ALWAYS_GLOBALS, ALWAYS_NS, GM_ALL_GLOBALS, GM_ALL_NS, resolveGrant } from '../gm-grants'
import type { GmInfo, Json } from './api-contract'
import { buildScriptBridgeSource } from './script-bridge'

export interface GmWrapperOptions {
  uuid: string
  name: string
  /** 注册时快照：该脚本在 duoling-usdata 里的全量值（同步读的底座） */
  values: Record<string, Json>
  /**
   * `GM_info`（SW 侧组装：metadata 视图 + 扩展版本 + uuid）。
   * `userAgent` / `isIncognito` 不在其中：它们只能在页面里取到，由包装运行时就地补齐。
   */
  info: Omit<GmInfo, 'userAgent' | 'isIncognito'>
  /** 脚本桥握手密钥（MAIN 侧 script-bridge 与 USER_SCRIPT 侧 script-relay 同源） */
  pageSecret: string
  /** `@grant` 声明（缺省 / 空 / 含 none → 空清单，只给恒注入集） */
  grant?: string[]
  /**
   * `@resource` 内容（名 → `{ text, url }`，url 是 data URI）：同步 API 的底座，注入时内联成常量表。
   * 未声明或抓取失败的资源不在这里面 —— 脚本取到 undefined（与不写 @grant 时成员不存在不同）。
   */
  resources?: Record<string, { text: string; url: string }>
  /**
   * `@run-at document-body`：注入仍走 `document_start`（Chrome 的 runAt 只认三种），
   * 但**正文**被包进「等 body 出现」的闸门里再跑（见 `__gmRunAtBody`）—— TM 的语义是 body 存在时才注入。
   */
  runAtBody?: boolean
}

/**
 * 按 `@grant` 算出「注入哪些成员」。语义对齐 Tampermonkey：
 *
 *   · **没写 `@grant`（含完全没有 metadata）→ 空清单**：只给恒注入集；
 *   · `@grant none` → 同「空清单」（TM 里 none 另有关闭沙箱之义，我们恒包一层 IIFE，故 API 面相同）；
 *   · 声明了则注入声明的成员 + 恒注入集。
 *
 * 刻意**不做**「无 grant 就全量注入」：那会让漏写清单的脚本在本扩展能跑、换到 TM 上立刻
 * ReferenceError —— 把真实问题掩盖过去，也让用户以为脚本没问题。
 * 认不出的 grant 名静默忽略（脚本用了会 ReferenceError，比「假装支持」好排查）。
 * 名字解析走 `resolveGrant`：`GM_setValue` 与 `GM.setValue` 两种写法都认。
 */
export function resolveGmExposure(grant: string[] | undefined): Record<string, boolean> {
  // 扁平一张表：全局名（`GM_xxxx`）与命名空间成员名（`getValue`）不重名，注入体里按名直查
  const flags: Record<string, boolean> = {}
  for (const name of [...GM_ALL_GLOBALS, ...GM_ALL_NS]) flags[name] = false
  for (const name of ALWAYS_GLOBALS) flags[name] = true
  for (const name of ALWAYS_NS) flags[name] = true
  for (const g of grant ?? []) {
    if (g === 'none') continue // 与「没写 @grant」同义：都不注入 GM 成员
    const m = resolveGrant(g)
    if (!m) continue
    for (const name of m.globals) flags[name] = true
    for (const name of m.ns) flags[name] = true
  }
  return flags
}

/** `GM_INFO` / 值快照等内联数据用 JSON 字面量；`</script>` 之类不受影响（js 数组注入，非内联 HTML） */
function jsonLiteral(v: unknown): string {
  return JSON.stringify(v ?? null)
}

/**
 * 生成注入源码的**开头部分**（未闭合的 IIFE）。
 *
 * 调用方（engine）负责把「本前缀 ＋ `@require` 源码 ＋ 脚本源码 ＋ 闭合的 `GM_WRAPPER_SUFFIX`」
 * 拼成**一条** code 注入 —— 三段必须在同一个函数作用域里，脚本才能按词法找到 `GM_*`（见文件头）。
 *
 * 注入体内部标识统一用 `__gm` 前缀（与桥的 `__dl` 信封区分：前者是包装层私有变量，可自由改名）。
 */
export function buildGmWrapperPrefix(opts: GmWrapperOptions): string {
  const exposure = resolveGmExposure(opts.grant)
  return `
;(function () {
  var GM_INFO = ${jsonLiteral(opts.info)}
  // userAgent 只能在页面里取（页面 UA 未必等于 SW 的 UA），注册侧不传、注入时就地补齐
  GM_INFO.userAgent = navigator.userAgent
  // MAIN 世界没有 chrome.*，隐身上下文取不到 —— 恒 false（要拿真值需经桥回 SW 查，暂不做）
  try { GM_INFO.isIncognito = !!(typeof chrome !== 'undefined' && chrome.extension && chrome.extension.inIncognitoContext) }
  catch (e) { GM_INFO.isIncognito = false }
  var GM_HAS = ${jsonLiteral(exposure)}
  // 值快照：注册时刻的全量值。同步读只认它；写过之后本地缓存立即更新（见 __gmSet）。
  var GM_VALUES = ${jsonLiteral(opts.values)}
  // @resource 内容：名 → { text, url(data URI) }。**同步 API 直接读它、不经桥** ——
  // 内容由注册/注入路径抓好后随本前缀一起注入（见 resource-cache.ts 与 engine.ts）。
  var GM_RESOURCES = ${jsonLiteral(opts.resources ?? {})}
  var NAME_PREFIX = '[GM:' + ${jsonLiteral(opts.name)} + ']'

  // —— 扩展侧通道：MAIN 世界没有 chrome.*，一切经同帧中继件（bridge-protocol.ts）。
  //    必须先于任何调用到位 —— 下面的 __gmAnnounceRun() 是立即调用的。——
  var __dlBridge = ${buildScriptBridgeSource(opts.pageSecret, opts.uuid)}
  // 下行推送统一入口：Port 就绪 / 值变更 / 菜单点击 / URL 变化 / 中继件通道重建都走它
  __dlBridge.onEvent(function (ev) { __gmHandleEvent(ev) })

  // —— 运行标识：**一次页面加载 = 一次运行**。注入即 mint，随错误记录上报并广播给 SW
  //    （对话界面页面监控据此按 tab 登记运行）——
  var __gmRunId = (function () {
    try { return crypto.randomUUID() }
    catch (e) { return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) }
  })()
  function __gmAnnounceRun() {
    try {
      var p = __dlBridge.emit({ __dlRunStart: true, name: GM_INFO.script.name, runId: __gmRunId })
      if (p && typeof p.catch === 'function') p.catch(function () { /* 中继件未就位：丢弃 */ })
    } catch (e) { /* 同上 */ }
  }
  __gmAnnounceRun()
  // load 时补播一次：脚本可能被配成 document_start，极早的广播会赶在 SW 唤醒前丢失
  if (document.readyState !== 'complete') window.addEventListener('load', __gmAnnounceRun)

  function __gmLog() {
    try { console.log.apply(console, [NAME_PREFIX].concat([].slice.call(arguments))) } catch (e) {}
  }

  // —— 运行期错误收集（错误日志面板）：本世界的未捕获异常 / 未处理拒绝经桥上报 ——
  function __gmReportError(message, stack, url) {
    try {
      var p = __dlBridge.emit({
        __dlEvent: true,
        name: GM_INFO.script.name,
        event: { t: 'error', phase: 'runtime', message: message, stack: stack, url: url, runId: __gmRunId },
      })
      // 必须吞掉失败：reject 会触发 unhandledrejection，又回到本函数形成自触发循环
      if (p && typeof p.catch === 'function') p.catch(function () { /* 桥不可用：丢弃 */ })
    } catch (e) {
      console.warn('[duoling:userscript] 上报异常：' + ((e && e.message) || e))
    }
  }
  window.addEventListener('error', function (e) {
    var err = e.error || {}
    __gmReportError(e.message || 'Script error', (err && err.stack) || '', location.href)
  })
  window.addEventListener('unhandledrejection', function (e) {
    var r = (e && e.reason) || {}
    __gmReportError('Unhandled rejection: ' + ((r && r.message) || String(e.reason)), (r && r.stack) || '', location.href)
  })

  // —— 桥请求：超时与传输都归 __dlBridge 管（见 bridge-protocol），这里只解释响应语义 ——
  function __gmSend(req) {
    return __dlBridge.call(req).then(function (resp) {
      if (!resp) {
        var e = new Error('GM 调用无响应：' + (req && req.c))
        e.code = 'BRIDGE_NO_RESPONSE'
        throw e
      }
      if (!resp.ok) {
        var e2 = new Error(resp.error || 'GM 调用失败')
        if (resp.code) e2.code = resp.code
        throw e2
      }
      return resp.data
    })
  }

  // —— Port 事件底座：控制面走 sendMessage 请求-响应；Port 只收下行推送帧。
  //    SW 注册表是内存态、冷启动归零，靠脚本侧重连重放恢复；菜单是浏览器级资源，
  //    其 id 由标题确定性派生（djb2）——随机 id 会让每次刷新都堆一条菜单。
  var __gmConnId = (function () {
    try { return crypto.randomUUID() }
    catch (e) { return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) }
  })()
  // 下行通道由中继件代连 Port：本侧只记「是否已请求过连接」与「SW 是否已推 port.ready」
  var __gmConnectStarted = false
  var __gmPortReady = false
  var __gmReadyWaiters = []
  var __gmActiveMenus = {}
  var __gmActiveWatches = {}
  var __gmActiveValueWatch = false
  var __gmMenuHandlers = {}
  var __gmWatchHandlers = {}
  var __gmNotifyHandlers = {}
  var __gmUrlChangeHandler = null

  function __gmMenuId(caption) {
    var h = 5381
    var s = String(caption || 'menu')
    for (var i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) | 0
    return h >>> 0
  }
  /** 桥侧菜单 id（字符串）：由与 GM_registerMenuCommand 返回值相同的确定性数字派生 */
  function __gmMenuKey(caption) { return 'm-' + __gmMenuId(caption).toString(36) }

  function __gmFireUrlChange(url) {
    var obj = { url: url }
    if (__gmUrlChangeHandler) { try { __gmUrlChangeHandler(obj) } catch (e) { __gmLog('onurlchange 回调异常', e) } }
    // addEventListener('urlchange') 形态：MAIN 世界可以直接派发真实事件——同帧所有脚本都收得到。
    // （隔离世界做不到，那时只能拦 window.addEventListener 做本地转发；那套会覆盖页面的
    //  addEventListener，在 MAIN 世界属于对页面的侵入，故不再用。）
    try { window.dispatchEvent(new CustomEvent('urlchange', { detail: obj })) } catch (e) {}
  }

  function __gmHandleEvent(ev) {
    if (!ev) return
    if (ev.t === 'port.ready') {
      __gmPortReady = true
      var ws = __gmReadyWaiters.splice(0)
      for (var wi = 0; wi < ws.length; wi++) ws[wi].resolve()
      // SW 冷启动重放：注册表归零 → 重发全部活跃注册（菜单撞 id 幂等由 SW 侧处理）
      var rreqs = []
      for (var mid in __gmActiveMenus) rreqs.push({ c: 'menu.register', id: mid, title: __gmActiveMenus[mid] })
      for (var wkey in __gmActiveWatches) rreqs.push({ c: 'store.watch', key: wkey, connId: __gmConnId })
      if (__gmActiveValueWatch) rreqs.push({ c: 'store.watchAll', connId: __gmConnId })
      for (var ri = 0; ri < rreqs.length; ri++) {
        __gmSend(rreqs[ri]).catch(function (e) { console.warn(NAME_PREFIX + ' 重放注册失败', e) })
      }
      return
    }
    if (ev.t === 'relay.port.closed') {
      // 中继件那侧 Port 断了（SW 重启 / 页面里换了代的中继件）：复位后重连。
      // SW 接通会重新推 port.ready，届时上面的重放逻辑把活跃注册补回来。
      __gmConnectStarted = false
      __gmPortReady = false
      setTimeout(__gmConnect, 100)
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
          try { entry.fn(ev.key, ev.oldValue == null ? undefined : ev.oldValue, ev.value == null ? undefined : ev.value, !!ev.remote) }
          catch (e) { __gmLog('GM_addValueChangeListener 回调异常', e) }
        }
      }
    } else if (ev.t === 'notify.click') {
      var nh = __gmNotifyHandlers[ev.id]
      if (nh) { try { nh() } catch (e) { __gmLog('通知点击回调异常', e) } }
    } else if (ev.t === 'url.change') {
      __gmFireUrlChange(ev.url)
    } else if (ev.t === 'audio.change') {
      // 只把**帧上真有的键**交给脚本：TM 的监听器靠 'muted' in e / 'audible' in e 区分
      // 是静音变化还是发声变化，多塞一个 undefined 键就会破坏这个判据。
      var ae = {}
      if ('muted' in ev) ae.muted = ev.muted
      if ('audible' in ev) ae.audible = ev.audible
      __gmFireAudioChange(ae)
    } else if (ev.t === 'xhr.progress') {
      var ph = __gmXhrProgress[ev.requestId]
      if (ph) {
        try { ph({ loaded: ev.loaded, total: ev.total, lengthComputable: ev.total != null }) }
        catch (e) { __gmLog('onprogress 回调异常', e) }
      }
    }
  }

  function __gmConnect() {
    if (__gmConnectStarted) return
    __gmConnectStarted = true
    // 中继件代连 Port；接通后 SW 推 port.ready，经桥回到 __gmHandleEvent
    __dlBridge.connect(__gmConnId).catch(function (e) {
      __gmConnectStarted = false // 握手失败（中继件未就位）：允许后续调用重试
      console.warn(NAME_PREFIX + ' 事件通道连接失败：' + ((e && e.message) || e))
    })
  }

  function __gmWaitReady() {
    if (__gmPortReady) return Promise.resolve()
    __gmConnect()
    return new Promise(function (resolve, reject) {
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
        }
      }
      __gmReadyWaiters.push(w)
    })
  }

  function __gmRegSend(req) {
    if (__gmPortReady) return __gmSend(req)
    return __gmWaitReady().then(function () { return __gmSend(req) })
  }

  // —— 值缓存（同步读的底座）——
  var __gmPendingWrites = {}
  function __gmHas(key) { return Object.prototype.hasOwnProperty.call(GM_VALUES, key) }
  function __gmGetSync(key, def) { return __gmHas(key) ? GM_VALUES[key] : def }
  function __gmListSync() { return Object.keys(GM_VALUES) }

  /**
   * 常驻通道：**读过值**就要把 Port 建起来，否则别的标签页写的新值永远到不了本实例，
   * 同步快照会整个页面生命周期陈旧。建立后补一次全量校准（覆盖 Port 就绪前的窗口）。
   */
  var __gmChannelReady = null
  function __gmEnsureChannel() {
    if (__gmChannelReady) return __gmChannelReady
    __gmChannelReady = new Promise(function (resolve) {
      __gmConnect()
      __gmWaitReady()
        .then(function () {
          __gmActiveValueWatch = true
          return __gmRegSend({ c: 'store.watchAll', connId: __gmConnId })
        })
        .then(function () {
          // 全量校准：跳过本实例还在飞行中的写（否则会用旧值覆盖本地刚写的）
          return __gmSend({ c: 'store.all' }).then(function (all) {
            var fresh = all || {}
            for (var k in fresh) if (Object.prototype.hasOwnProperty.call(fresh, k) && !__gmPendingWrites[k]) GM_VALUES[k] = fresh[k]
            for (var old in GM_VALUES) if (!Object.prototype.hasOwnProperty.call(fresh, old) && !__gmPendingWrites[old]) delete GM_VALUES[old]
          })
        })
        .then(resolve, function (e) {
          console.warn(NAME_PREFIX + ' 值通道未就绪（跨标签页变更暂不可见，同步读仍可用快照）：' + ((e && e.message) || e))
          resolve()
        })
    })
    return __gmChannelReady
  }

  function __gmSetSync(key, value, isDelete) {
    if (isDelete) delete GM_VALUES[key]
    else GM_VALUES[key] = value
    __gmPendingWrites[key] = true
    var req = isDelete
      ? { c: 'store.delete', key: key, connId: __gmConnId }
      : { c: 'store.set', key: key, value: value, connId: __gmConnId }
    return __gmSend(req).then(function () {
      delete __gmPendingWrites[key]
    }, function (e) {
      delete __gmPendingWrites[key]
      __gmLog((isDelete ? 'GM_deleteValue' : 'GM_setValue') + ' 落盘失败：' + ((e && e.message) || e))
      throw e
    })
  }

  /**
   * 批量写 / 批量删（GM_setValues / GM_deleteValues 的底座）。
   *
   * 与单键 __gmSetSync 的差别只在**请求次数**：本地镜像仍逐键改（同步读立刻可见），
   * 落盘走一条 store.setMany / store.deleteMany（服务端一个事务），变更事件在服务端逐键发。
   * 同步形态（GM_setValues）不关心返回值、失败只记日志；异步形态（GM.setValues）直接返回它。
   */
  function __gmSetManySync(input, isDelete) {
    var keys = isDelete ? (input || []).slice() : Object.keys(input || {})
    if (!keys.length) return Promise.resolve()
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i]
      if (isDelete) delete GM_VALUES[k]
      else GM_VALUES[k] = input[k]
      __gmPendingWrites[k] = true
    }
    var req = isDelete
      ? { c: 'store.deleteMany', keys: keys, connId: __gmConnId }
      : { c: 'store.setMany', entries: input, connId: __gmConnId }
    return __gmSend(req).then(function () {
      for (var j = 0; j < keys.length; j++) delete __gmPendingWrites[keys[j]]
    }, function (e) {
      for (var j = 0; j < keys.length; j++) delete __gmPendingWrites[keys[j]]
      __gmLog((isDelete ? 'GM_deleteValues' : 'GM_setValues') + ' 落盘失败：' + ((e && e.message) || e))
      throw e
    })
  }

  /**
   * GM_getValues 的取值口径 —— 同步与异步两个形态**共用这一处**，免得两套语义：
   *   · 不给参数 → 整份存储；
   *   · 给键数组 → 只含**存在**的键（不存在的键不出现在结果里，对齐 TM）；
   *   · 给默认值对象 → 按它补缺，键存在时用真值。
   * 一律返回**新对象**：绝不把内部镜像透出去（脚本改它不该动到包装层的缓存）。
   */
  function __gmPickValues(source, keysOrDefaults) {
    var out = {}
    if (keysOrDefaults == null) {
      for (var k in source) if (Object.prototype.hasOwnProperty.call(source, k)) out[k] = source[k]
      return out
    }
    if (Array.isArray(keysOrDefaults)) {
      for (var i = 0; i < keysOrDefaults.length; i++) {
        var key = keysOrDefaults[i]
        if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key]
      }
      return out
    }
    for (var d in keysOrDefaults) if (Object.prototype.hasOwnProperty.call(keysOrDefaults, d)) {
      out[d] = Object.prototype.hasOwnProperty.call(source, d) ? source[d] : keysOrDefaults[d]
    }
    return out
  }

  // —— 二进制 / FormData 请求体编码（GM_xmlhttpRequest 的 data）——
  function __gmBase64ToArrayBuffer(b64) {
    var bin = atob(b64)
    var buf = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
    return buf.buffer
  }
  function __gmBytesToBase64(bytes) {
    var s = ''
    var chunk = 0x8000
    for (var i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
    }
    return btoa(s)
  }
  function __gmCopyInit(s) {
    var c = {}
    for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k) && s[k] !== undefined) c[k] = s[k]
    return c
  }
  function __gmCopyHeaders(h) {
    var c = {}
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) c[k] = h[k]
    return c
  }
  /** 把 data（string/Blob/FormData/ArrayBuffer/TypedArray/DataView）编码成可跨桥的 init */
  function __gmEncodeBody(raw) {
    if (raw == null || typeof raw === 'string') return Promise.resolve(null)
    if (typeof Blob !== 'undefined' && raw instanceof Blob) {
      return raw.arrayBuffer().then(function (buf) {
        var env = { __dlBinaryBody: true, base64: __gmBytesToBase64(new Uint8Array(buf)) }
        return function (s) {
          var c = __gmCopyInit(s)
          c.body = env
          var t = raw.type
          if (t && (!c.headers || c.headers['content-type'] == null)) {
            c.headers = __gmCopyHeaders(c.headers || {})
            c.headers['content-type'] = t
          }
          return c
        }
      })
    }
    if (typeof FormData !== 'undefined' && raw instanceof FormData) {
      var fields = []
      var pending = []
      raw.forEach(function (value, name) {
        if (typeof value === 'string') {
          fields.push({ name: name, value: value })
        } else {
          pending.push(value.arrayBuffer().then(function (buf) {
            var f = typeof File !== 'undefined' && value instanceof File ? value.name : undefined
            fields.push({ name: name, base64: __gmBytesToBase64(new Uint8Array(buf)), type: value.type || 'application/octet-stream', filename: f })
          }))
        }
      })
      return Promise.all(pending).then(function () {
        return function (s) {
          var c = __gmCopyInit(s)
          c.body = { __dlFormData: true, fields: fields }
          return c
        }
      })
    }
    if (typeof raw === 'object') {
      var bytes
      if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw)
      else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(raw)) bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
      else return Promise.reject(new Error('GM_xmlhttpRequest：data 仅支持 string / Blob / FormData / ArrayBuffer / TypedArray / DataView'))
      var env2 = { __dlBinaryBody: true, base64: __gmBytesToBase64(bytes) }
      return Promise.resolve(function (s) { var c = __gmCopyInit(s); c.body = env2; return c })
    }
    return Promise.reject(new Error('GM_xmlhttpRequest：data 仅支持 string / Blob / FormData / ArrayBuffer / TypedArray / DataView'))
  }

  // —— GM.page（本扩展独有能力）：脚本与页面同处 MAIN 世界，两个方法都能**本地实现** ——
  //    直接 addEventListener / 包 window.fetch 即可（绕 postMessage 找桩是隔离世界的做法）。

  /** 事件摘要：只留可结构化克隆的字段 */
  function __gmSummarizeEvent(e) {
    var ev = { type: e.type, timeStamp: e.timeStamp || 0 }
    if (typeof e.key === 'string') ev.key = e.key
    var detail = null
    try {
      if (e && typeof e === 'object' && 'detail' in e && e.detail != null) detail = JSON.parse(JSON.stringify(e.detail))
    } catch (e2) { detail = null }
    ev.detail = detail
    return ev
  }

  /** selector 过滤：target 自身命中或沿祖先链命中（不依赖注入时刻的元素快照，晚出现的元素也命中） */
  function __gmHitSelector(e, selector) {
    var t = e.target
    if (!t || typeof t.matches !== 'function') return false
    try { return t.matches(selector) || !!(t.closest && t.closest(selector)) } catch (e2) { return false }
  }

  /** fetch 出站摘要（裁决函数看到的形状） */
  function __gmSummarizeFetch(args) {
    var input = args[0]
    var init = args[1]
    var url = ''
    var method = 'GET'
    var headers = {}
    var body = null
    try {
      if (input && typeof input === 'object' && typeof input.url === 'string') {
        url = input.url
        method = String(input.method || 'GET')
        if (input.headers && typeof input.headers.forEach === 'function') {
          input.headers.forEach(function (v, k) { headers[k] = String(v) })
        }
      } else {
        url = String(input)
        method = String((init && init.method) || 'GET')
        var h = init && init.headers
        if (h && typeof h.forEach === 'function') h.forEach(function (v, k) { headers[k] = String(v) })
        else if (h && typeof h === 'object') {
          for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) headers[k] = String(h[k])
        }
        if (init && typeof init.body === 'string') body = init.body
      }
    } catch (e2) { /* 摘要失败按空值转发，不阻塞页面请求 */ }
    return { url: url, method: method, headers: headers, body: body }
  }

  /** 响应体采样上限：防大响应把内存读爆 */
  var __gmFetchMaxBody = 1 << 20
  /** 本脚本的 fetch 包装层状态（同帧多脚本各包一层、链式相套，后包者先处理） */
  var __gmFetchLayer = null

  /** passthrough 时被动读响应体：克隆后异步读，原响应不消耗 */
  function __gmObserveFetch(real, url, onResponse) {
    try {
      Promise.resolve(real).then(function (resp) {
        try {
          var cloned = resp.clone()
          cloned.text().then(function (text) {
            var truncated = false
            if (text.length > __gmFetchMaxBody) { text = text.slice(0, __gmFetchMaxBody); truncated = true }
            var headers = {}
            try { resp.headers.forEach(function (v, k) { headers[k] = v }) } catch (e3) {}
            try {
              onResponse({ url: url, status: resp.status, statusText: resp.statusText || '', headers: headers, body: text, truncated: truncated })
            } catch (e3) { /* 回调异常不拖垮网络层 */ }
          }).catch(function () { /* 读体失败忽略 */ })
        } catch (e3) { /* clone 失败忽略 */ }
      }, function () { /* 请求失败：无可观察的响应 */ })
    } catch (e3) { /* 忽略 */ }
  }

  function __gmPageFetchHook(handler, opts) {
    if (typeof handler !== 'function') return Promise.reject(new Error('GM.page.fetchHook 需要裁决函数'))
    var onResponse = opts && typeof opts.onResponse === 'function' ? opts.onResponse : null
    if (!__gmFetchLayer) {
      var layer = { handler: null, onResponse: null, prev: window.fetch }
      layer.wrapper = function () {
        var args = arguments
        if (typeof layer.handler !== 'function') return layer.prev.apply(window, args) // 已卸载：透传
        var call = __gmSummarizeFetch(args)
        var decision
        try { decision = layer.handler(call) } catch (e2) { decision = null }
        // 裁决等待设上限：宁可失效也不阻塞页面网络层（与注入体其它钩子同一取舍）
        return new Promise(function (resolve) {
          var settled = false
          var timer = setTimeout(function () { if (!settled) { settled = true; resolve(null) } }, 500)
          Promise.resolve(decision).then(function (a) {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(a)
          }, function () {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(null)
          })
        }).then(function (action) {
          if (action && action.action === 'respond') {
            try {
              return new Response(action.body || '', { status: action.status || 200, headers: action.headers || {} })
            } catch (e2) { /* Response 构造失败：退回真实请求 */ }
          }
          var real = layer.prev.apply(window, args)
          if (typeof layer.onResponse === 'function') __gmObserveFetch(real, call.url, layer.onResponse)
          return real
        })
      }
      __gmFetchLayer = layer
      window.fetch = layer.wrapper
    }
    __gmFetchLayer.handler = handler
    __gmFetchLayer.onResponse = onResponse
    // 卸载**不做链上摘除**（同帧多脚本各持一层，跨脚本协调做不到）：清空本层裁决，
    // 该层从此在链上一律透传 —— 页面网络层照常，只是不再经过本脚本。
    return Promise.resolve(function () {
      if (__gmFetchLayer) {
        __gmFetchLayer.handler = null
        __gmFetchLayer.onResponse = null
      }
    })
  }

  var __gmPageApi = {
    listen: function (type, handler, opts) {
      if (typeof handler !== 'function') return Promise.reject(new Error('GM.page.listen 需要事件回调函数'))
      var t = String(type)
      var selector = opts && opts.selector ? String(opts.selector) : ''
      var once = !!(opts && opts.once)
      var fn = function (ev) {
        if (selector && !__gmHitSelector(ev, selector)) return
        if (once) { try { window.removeEventListener(t, fn, true) } catch (e2) {} }
        try { handler(__gmSummarizeEvent(ev)) } catch (e2) { /* 回调异常不拖垮页面 */ }
      }
      window.addEventListener(t, fn, { capture: true, once: once })
      return Promise.resolve(function () {
        try { window.removeEventListener(t, fn, true) } catch (e2) {}
      })
    },
    fetchHook: __gmPageFetchHook
  }

  function __gmAddStyle(css) {
    var el = document.createElement('style')
    el.textContent = css
    ;(document.head || document.documentElement).appendChild(el)
    return el
  }
  function __gmAddElement(a, b, c) {
    var parent, tag, attrs
    if (typeof a === 'string') { parent = document.head || document.documentElement; tag = a; attrs = b }
    else { parent = a; tag = b; attrs = c }
    var el = document.createElement(tag)
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue
        try { el.setAttribute(k, attrs[k]) } catch (e) {}
      }
    }
    if (parent && parent.appendChild) parent.appendChild(el)
    return el
  }
  function __gmTriggerAnchor(href, name) {
    var a = document.createElement('a')
    a.href = href
    a.download = name || 'download'
    ;(document.body || document.documentElement).appendChild(a)
    a.click()
    a.remove()
  }
  function __gmRawHeaders(obj) {
    var out = ''
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) out += k + ': ' + obj[k] + '\\r\\n'
    return out
  }
  function __gmWithCb(p, cb) {
    if (typeof cb !== 'function') return
    p.then(function (v) { try { cb(v) } catch (e) {} }, function (e) { try { cb(undefined, (e && e.message) || String(e)) } catch (_) {} })
  }
  function __gmWithErrCb(p, cb) {
    if (typeof cb !== 'function') return
    p.then(function () { try { cb(null) } catch (e) {} }, function (e) { try { cb((e && e.message) || String(e)) } catch (_) {} })
  }

  /** GM_xmlhttpRequest：回调式（TM 形状）+ 返回可 abort 的句柄 */
  function __gmXhr(details) {
    var d = details || {}
    var requestId = (function () {
      try { return crypto.randomUUID() }
      catch (e) { return 'x-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) }
    })()
    var rt = d.responseType
    var responseType = rt === 'json' || rt === 'arraybuffer' || rt === 'blob' ? rt : 'text'
    if (rt === 'document' || rt === 'stream') {
      __gmLog('GM_xmlhttpRequest：responseType「' + rt + '」不受支持，已按 text 处理')
      responseType = 'text'
    }
    var aborted = false
    function base(status, statusText, headers, url) {
      return { readyState: 4, status: status, statusText: statusText, responseHeaders: __gmRawHeaders(headers || {}), finalUrl: url || d.url, context: d.context }
    }
    function toResponse(p) {
      var r = base(p.status, p.statusText, p.headers, p.url)
      var text = p.body || ''
      r.responseText = responseType === 'text' || responseType === 'json' ? text : ''
      if (responseType === 'arraybuffer') r.response = __gmBase64ToArrayBuffer(text)
      else if (responseType === 'blob') r.response = new Blob([__gmBase64ToArrayBuffer(text)], { type: (p.headers && p.headers['content-type']) || '' })
      else if (responseType === 'json') { try { r.response = JSON.parse(text) } catch (e) { r.response = null } }
      else r.response = text
      return r
    }
    var handle = {
      abort: function () {
        if (aborted) return
        aborted = true
        __gmSend({ c: 'fetch.abort', requestId: requestId }).catch(function () {})
        if (d.onabort) { try { d.onabort(base(0, '', {}, d.url)) } catch (e) {} }
      }
    }
    if (d.onloadstart) { try { d.onloadstart(base(0, '', {}, d.url)) } catch (e) {} }
    var chain = __gmEncodeBody(d.data).then(function (encode) {
      var wantsProgress = typeof d.onprogress === 'function'
      if (wantsProgress) __gmRegisterXhrProgress(requestId, d.onprogress)
      var init = { method: d.method, headers: d.headers, responseType: responseType === 'text' || responseType === 'json' ? 'text' : 'arraybuffer', timeout: d.timeout, redirect: d.redirect, requestId: requestId, wantProgress: wantsProgress, connId: __gmConnId }
      return __gmSend({ c: 'fetch', url: d.url, init: encode ? encode(init) : init })
    })
    // 登记与请求同生命周期（成功 / 失败 / 中止都清）
    var __gmProgressDone = function () { __gmUnregisterXhrProgress(requestId) }
    chain.then(__gmProgressDone, __gmProgressDone)
    chain.then(function (p) {
      if (aborted) return
      var resp = toResponse(p)
      if (d.onreadystatechange) { try { d.onreadystatechange(resp) } catch (e) {} }
      if (d.onload) { try { d.onload(resp) } catch (e) {} }
    }, function (e) {
      if (aborted) return
      var code = e && e.code
      var r = base(0, '', {}, d.url)
      if (code === 'BRIDGE_TIMEOUT') {
        if (d.ontimeout) { try { d.ontimeout(r) } catch (_) {} }
        return
      }
      if (d.onerror) {
        var errResp = base(0, '', {}, d.url)
        errResp.error = (e && e.message) || '请求失败'
        try { d.onerror(errResp) } catch (_) {}
      }
    })
    return handle
  }

  /** GM_download：URL 字符串 / details 对象 / Blob（本地直下，不过桥） */
  function __gmDownload(input, name) {
    if (typeof input === 'string') {
      return __gmSend({ c: 'download', url: input, name: name }).then(function (r) { __gmTriggerAnchor(r.dataUrl, r.name) })
    }
    if (input && typeof input === 'object' && typeof input.url === 'string') {
      if (input.saveAs) __gmLog('GM_download：saveAs 不受支持（走 a[download]，无法弹另存为），已忽略')
      return __gmSend({ c: 'download', url: input.url, name: input.name || name }).then(function (r) {
        __gmTriggerAnchor(r.dataUrl, r.name)
        if (input.onload) { try { input.onload() } catch (e) {} }
      }, function (e) {
        if (input.onerror) { try { input.onerror({ error: (e && e.message) || '下载失败' }) } catch (_) {} }
        throw e
      })
    }
    var blob = null
    if (typeof Blob !== 'undefined' && input instanceof Blob) blob = input
    else if (input instanceof ArrayBuffer) blob = new Blob([input])
    else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(input)) blob = new Blob([new Uint8Array(input.buffer, input.byteOffset, input.byteLength)])
    if (!blob) return Promise.reject(new Error('GM_download：首参仅支持 URL 字符串 / details 对象 / Blob / ArrayBuffer / TypedArray'))
    var url = URL.createObjectURL(blob)
    try {
      __gmTriggerAnchor(url, name)
    } finally {
      setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
    }
    return Promise.resolve()
  }

  function __gmOpenInTab(url, options) {
    var active = true
    if (typeof options === 'boolean') active = options
    else if (options && typeof options === 'object' && typeof options.active === 'boolean') active = options.active
    var tabId = null
    var pendingClose = false
    var handle = {
      closed: false,
      close: function () {
        if (handle.closed) return
        handle.closed = true
        if (tabId == null) { pendingClose = true; return }
        __gmSend({ c: 'tabs.close', tabId: tabId }).catch(function () {})
      }
    }
    __gmSend({ c: 'tabs.open', url: url, active: active }).then(function (id) {
      tabId = id
      if (pendingClose) handle.close()
    }, function (e) { __gmLog('GM_openInTab 失败：' + ((e && e.message) || e)) })
    return handle
  }

  function __gmNotify(a, b, c, d) {
    var msg, title, icon, onclick
    if (a && typeof a === 'object') { msg = a.text; title = a.title; icon = a.image; onclick = a.onclick }
    else { msg = a; title = b; icon = c; onclick = d }
    return __gmSend({ c: 'notify', message: String(msg == null ? '' : msg), title: title, icon: icon }).then(function (r) {
      if (typeof onclick === 'function' && r && r.id) __gmNotifyHandlers[r.id] = onclick
    })
  }

  function __gmSetClipboard(data, info) {
    var type = typeof info === 'string' ? info : 'text/plain'
    if (type === 'text/html') return __gmSend({ c: 'clipboard.write', html: String(data) })
    return __gmSend({ c: 'clipboard.write', text: String(data) })
  }

  function __gmRegisterMenu(caption, onClick, options) {
    var title = typeof options === 'object' && options && typeof options.title === 'string' ? options.title : caption
    var id = __gmMenuKey(caption)
    __gmMenuHandlers[id] = onClick
    __gmActiveMenus[id] = title
    __gmEnsureChannel()
    __gmRegSend({ c: 'menu.register', id: id, title: title }).catch(function (e) {
      __gmLog('GM_registerMenuCommand 登记失败：' + ((e && e.message) || e))
    })
    return __gmMenuId(caption)
  }
  function __gmUnregisterMenu(idOrCaption) {
    var id = typeof idOrCaption === 'number' ? 'm-' + (idOrCaption >>> 0).toString(36) : __gmMenuKey(idOrCaption)
    delete __gmMenuHandlers[id]
    delete __gmActiveMenus[id]
    __gmRegSend({ c: 'menu.unregister', id: id }).catch(function () {})
  }

  var __gmListenerSeq = 0
  // —— 请求进度登记（GM_xmlhttpRequest 的 onprogress）——
  // 进度帧按 requestId 回来，这张表记住"哪个 requestId 要回调哪个函数"。请求结束（成功 / 失败 /
  // 中止）都要清 —— 否则脚本跑久了表只增不减。
  var __gmXhrProgress = {}
  function __gmRegisterXhrProgress(requestId, fn) { __gmXhrProgress[requestId] = fn }
  function __gmUnregisterXhrProgress(requestId) { delete __gmXhrProgress[requestId] }

  // —— 音频状态监听（GM_audio.addStateChangeListener）——
  // TM 用**函数引用**标识监听器（没有 id 机制）：本地就是一张函数数组，由空变非空时订阅、
  // 非空变空时退订 —— 与值监听同款「按需订阅」，没有监听就不收 audio.change 帧。
  var __gmAudioHandlers = []
  var __gmAudioWatching = false
  function __gmAudioSetWatch(want) {
    if (want === __gmAudioWatching) return
    __gmAudioWatching = want
    // 命令名写成两个字面量（不要用三元拼字符串）—— 契约一致性单测按**字面量**反射
    // 「哪条命令由谁发出」，拼出来的名字它看不见，会被判成「没人发的死命令」。
    var req = want ? { c: 'audio.watch', connId: __gmConnId } : { c: 'audio.unwatch', connId: __gmConnId }
    __gmRegSend(req).catch(function (e) {
      __gmLog('GM_audio 订阅失败：' + ((e && e.message) || e))
    })
  }
  function __gmAddAudioListener(fn) {
    __gmAudioHandlers.push(fn)
    __gmAudioSetWatch(true)
  }
  function __gmRemoveAudioListener(fn) {
    var i = __gmAudioHandlers.indexOf(fn)
    if (i < 0) return
    __gmAudioHandlers.splice(i, 1)
    if (!__gmAudioHandlers.length) __gmAudioSetWatch(false)
  }
  function __gmFireAudioChange(ev) {
    var list = __gmAudioHandlers.slice()
    for (var i = 0; i < list.length; i++) {
      try { list[i](ev) } catch (e) { __gmLog('GM_audio 监听回调异常', e) }
    }
  }

  function __gmAddValueChangeListener(key, cb) {
    var id = ++__gmListenerSeq
    if (!__gmWatchHandlers[key]) __gmWatchHandlers[key] = []
    __gmWatchHandlers[key].push({ id: id, fn: cb })
    __gmActiveWatches[key] = true
    __gmEnsureChannel()
    __gmRegSend({ c: 'store.watch', key: key, connId: __gmConnId }).catch(function (e) {
      __gmLog('GM_addValueChangeListener 订阅失败：' + ((e && e.message) || e))
    })
    return id
  }
  function __gmRemoveValueChangeListener(listenerId) {
    for (var key in __gmWatchHandlers) {
      if (!Object.prototype.hasOwnProperty.call(__gmWatchHandlers, key)) continue
      var arr = __gmWatchHandlers[key]
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].id !== listenerId) continue
        arr.splice(i, 1)
        if (!arr.length) {
          delete __gmWatchHandlers[key]
          delete __gmActiveWatches[key]
          __gmRegSend({ c: 'store.unwatch', key: key, connId: __gmConnId }).catch(function () {})
        }
        return
      }
    }
  }
  /**
   * 不支持的字段**显式拒绝**、不静默忽略 —— 静默会让脚本以为自己写成了。
   *
   * domain / path 在 set 上已照 TM 收下（传 allowDomainPath = true）；list / delete 的
   * 这两个**查询条件**尚未实现，传了仍报错（否则脚本会以为筛过了）。
   */
  function __gmCookieReject(q, allowDomainPath) {
    if (!allowDomainPath && q && (q.domain != null || q.path != null)) {
      return new Error('GM_cookie：list / delete 的 domain / path 查询尚未支持（set 已支持这两个字段）')
    }
    return null
  }

  var __gmCookie = {
    list: function (details, cb) {
      var q = details || {}
      var bad = __gmCookieReject(q)
      var p = bad ? Promise.reject(bad) : __gmSend({ c: 'cookie.get', url: q.url || location.href, name: q.name })
      __gmWithCb(p, cb)
      return p
    },
    set: function (details, cb) {
      var d = details || {}
      var bad = __gmCookieReject(d, true)
      var p = bad ? Promise.reject(bad) : __gmSend({
        c: 'cookie.set', url: d.url || location.href, name: d.name, value: d.value,
        secure: d.secure, httpOnly: d.httpOnly, expirationDate: d.expirationDate,
        domain: d.domain, path: d.path
      })
      __gmWithErrCb(p, cb)
      return p
    },
    delete: function (details, cb) {
      var d = details || {}
      var p = __gmSend({ c: 'cookie.remove', url: d.url || location.href, name: d.name })
      __gmWithErrCb(p, cb)
      return p
    }
  }

  // —— @resource 取值（TM：文本 / base64 data URI，都是**同步**返回）——
  //    取不到（未声明该名、或抓取失败）返回 undefined 并记一条日志：报错会把脚本整段带崩，
  //    而 TM 这类「拿不到素材」的情形脚本自己判 undefined 更常见。
  function __gmResource(name, wantUrl) {
    var r = GM_RESOURCES[name]
    if (!r) {
      __gmLog((wantUrl ? 'GM_getResourceURL' : 'GM_getResourceText') + '：资源 ' + name + ' 不存在（未声明或抓取失败）')
      return undefined
    }
    return wantUrl ? r.url : r.text
  }

  // —— @run-at document-body 的闸门：body 出现后才执行正文 ——
  //    Chrome 的 userScripts.runAt 只有 start / end / idle，没有 body，故注入用 document_start +
  //    闸门把**正文**推后。包装层自身（GM 成员挂载、Port 连接、事件监听）不等 —— 它不碰页面 DOM，
  //    早跑没有副作用，而等它会白白推迟脚本能调 GM API 的时点。
  //    两条触发路径都挂上并各自幂等：MutationObserver 抓 body 插入，DOMContentLoaded 兜底。
  function __gmRunAtBody(fn) {
    if (document.body) { fn(); return }
    var done = false
    var fire = function () {
      if (done || !document.body) return
      done = true
      if (mo) { try { mo.disconnect() } catch (e) {} }
      fn()
    }
    var mo = null
    try {
      mo = new MutationObserver(fire)
      mo.observe(document, { childList: true, subtree: true })
    } catch (e) { mo = null }
    document.addEventListener('DOMContentLoaded', fire, { once: true })
  }

  // —— 音频控制（TM v5.0+）：4 个成员都作用于**当前标签页**。回调可省 → 返回 Promise
  //    （TM 里 getState 的回调是必需的，这里放宽；回调形状照 TM：getState 回状态对象，其余回 error）——
  var __gmAudioApi = {
    setMute: function (details, cb) {
      var p = __gmSend({ c: 'audio.setMute', isMuted: !!(details && details.isMuted) })
      if (typeof cb === 'function') p.then(function () { cb() }, function (e) { cb((e && e.message) || String(e)) })
      return p
    },
    getState: function (cb) {
      var p = __gmSend({ c: 'audio.getState' }).then(function (s) { return s || {} })
      if (typeof cb === 'function') p.then(function (s) { cb(s) }, function (e) { __gmLog('GM_audio.getState 失败：' + ((e && e.message) || e)) })
      return p
    },
    // 订阅登记交给 __gmAddAudioListener：它管「表由空变非空才订阅」的那层节流
    addStateChangeListener: function (fn, cb) {
      var p = __gmWaitReady().then(function () { __gmAddAudioListener(fn) })
      if (typeof cb === 'function') p.then(function () { cb() }, function (e) { cb((e && e.message) || String(e)) })
      return p
    },
    removeStateChangeListener: function (fn, cb) {
      var p = __gmWaitReady().then(function () { __gmRemoveAudioListener(fn) })
      if (typeof cb === 'function') p.then(function () { cb() }, function (e) { cb((e && e.message) || String(e)) })
      return p
    },
  }

  // —— 组装成员（按 @grant 裁剪：GM_HAS 由注册侧算好）——
  // 全部声明为**局部变量**而非挂 window：同帧多脚本共享一个 window，挂上去会互相覆盖；
  // 而脚本与本包装拼在同一条 code 里（同一函数作用域），按词法即可拿到（见文件头说明）。
  var GM_info, GM_getValue, GM_listValues, GM_setValue, GM_deleteValue,
      GM_getValues, GM_setValues, GM_deleteValues,
      GM_addValueChangeListener, GM_removeValueChangeListener, GM_registerMenuCommand,
      GM_unregisterMenuCommand, GM_addStyle, GM_addElement, GM_log, GM_notification,
      GM_setClipboard, GM_xmlhttpRequest, GM_download, GM_openInTab, GM_cookie,
      GM_audio, GM_getResourceText, GM_getResourceURL, GM_getTab, GM_saveTab, GM_getTabs
  if (GM_HAS.GM_info) GM_info = GM_INFO
  if (GM_HAS.GM_getValue) GM_getValue = function (key, def) { __gmEnsureChannel(); return __gmGetSync(key, def) }
  if (GM_HAS.GM_listValues) GM_listValues = function () { __gmEnsureChannel(); return __gmListSync() }
  if (GM_HAS.GM_setValue) GM_setValue = function (key, value) { __gmEnsureChannel(); __gmSetSync(key, value, false).catch(function () {}) }
  if (GM_HAS.GM_deleteValue) GM_deleteValue = function (key) { __gmEnsureChannel(); __gmSetSync(key, undefined, true).catch(function () {}) }
  // 批量版（同步形态）：读本地镜像、写一条批量命令，语义见 __gmPickValues / __gmSetManySync
  if (GM_HAS.GM_getValues) GM_getValues = function (keysOrDefaults) { __gmEnsureChannel(); return __gmPickValues(GM_VALUES, keysOrDefaults) }
  if (GM_HAS.GM_setValues) GM_setValues = function (values) { __gmEnsureChannel(); __gmSetManySync(values, false).catch(function () {}) }
  if (GM_HAS.GM_deleteValues) GM_deleteValues = function (keys) { __gmEnsureChannel(); __gmSetManySync(keys, true).catch(function () {}) }
  if (GM_HAS.GM_addValueChangeListener) GM_addValueChangeListener = __gmAddValueChangeListener
  if (GM_HAS.GM_removeValueChangeListener) GM_removeValueChangeListener = __gmRemoveValueChangeListener
  if (GM_HAS.GM_registerMenuCommand) GM_registerMenuCommand = __gmRegisterMenu
  if (GM_HAS.GM_unregisterMenuCommand) GM_unregisterMenuCommand = __gmUnregisterMenu
  if (GM_HAS.GM_addStyle) GM_addStyle = __gmAddStyle
  if (GM_HAS.GM_addElement) GM_addElement = __gmAddElement
  if (GM_HAS.GM_log) GM_log = function () { __gmLog.apply(null, arguments) }
  if (GM_HAS.GM_notification) GM_notification = function (a, b, c, d) { __gmNotify(a, b, c, d).catch(function () {}) }
  if (GM_HAS.GM_setClipboard) GM_setClipboard = function (data, info) { __gmSetClipboard(data, info).catch(function () {}) }
  if (GM_HAS.GM_xmlhttpRequest) GM_xmlhttpRequest = __gmXhr
  if (GM_HAS.GM_download) GM_download = function (input, name) { __gmDownload(input, name).catch(function () {}) }
  if (GM_HAS.GM_openInTab) GM_openInTab = __gmOpenInTab
  if (GM_HAS.GM_cookie) GM_cookie = __gmCookie
  if (GM_HAS.GM_getResourceText) GM_getResourceText = function (name) { return __gmResource(name, false) }
  if (GM_HAS.GM_getResourceURL) GM_getResourceURL = function (name) { return __gmResource(name, true) }
  if (GM_HAS.GM_audio) GM_audio = __gmAudioApi
  if (GM_HAS.GM_getTab) GM_getTab = function (cb) {
    __gmSend({ c: 'tab.get' }).then(function (v) { if (typeof cb === 'function') cb(v) }, function (e) { __gmLog('GM_getTab 失败：' + ((e && e.message) || e)); if (typeof cb === 'function') cb(undefined) })
  }
  if (GM_HAS.GM_saveTab) GM_saveTab = function (tab, cb) {
    __gmSend({ c: 'tab.save', value: tab }).then(function () { if (typeof cb === 'function') cb() }, function (e) { __gmLog('GM_saveTab 失败：' + ((e && e.message) || e)); if (typeof cb === 'function') cb() })
  }
  if (GM_HAS.GM_getTabs) GM_getTabs = function (cb) {
    __gmSend({ c: 'tab.all' }).then(function (v) { if (typeof cb === 'function') cb(v || {}) }, function (e) { __gmLog('GM_getTabs 失败：' + ((e && e.message) || e)); if (typeof cb === 'function') cb({}) })
  }

  // —— 组装 GM.* 命名空间（Promise 形态；读走桥＝永远新鲜，写先更缓存）——
  var GM = {}
  if (GM_HAS.info) GM.info = GM_INFO
  if (GM_HAS.getValue) GM.getValue = function (key, def) {
    __gmEnsureChannel()
    return __gmSend({ c: 'store.get', key: key }).then(function (v) {
      if (v === undefined) return def
      GM_VALUES[key] = v
      return v
    })
  }
  if (GM_HAS.listValues) GM.listValues = function () { return __gmSend({ c: 'store.keys' }) }
  if (GM_HAS.setValue) GM.setValue = function (key, value) { return __gmSetSync(key, value, false) }
  if (GM_HAS.deleteValue) GM.deleteValue = function (key) { return __gmSetSync(key, undefined, true) }
  // 批量版（异步形态）：读走桥＝**服务端最新**（与 GM.getValue 同口径，不只本地快照）；
  // 只取请求的键（store.getMany），不像 store.all 那样把整份存储搬过桥。
  if (GM_HAS.getValues) GM.getValues = function (keysOrDefaults) {
    var want = keysOrDefaults == null ? null : (Array.isArray(keysOrDefaults) ? keysOrDefaults : Object.keys(keysOrDefaults))
    if (want === null) {
      return __gmSend({ c: 'store.all' }).then(function (all) { return __gmPickValues(all || {}, null) })
    }
    return __gmSend({ c: 'store.getMany', keys: want }).then(function (found) {
      return __gmPickValues(found || {}, keysOrDefaults)
    })
  }
  if (GM_HAS.setValues) GM.setValues = function (values) { return __gmSetManySync(values, false) }
  if (GM_HAS.deleteValues) GM.deleteValues = function (keys) { return __gmSetManySync(keys, true) }
  if (GM_HAS.addValueChangeListener) GM.addValueChangeListener = function (key, cb) { return Promise.resolve(__gmAddValueChangeListener(key, cb)) }
  if (GM_HAS.removeValueChangeListener) GM.removeValueChangeListener = __gmRemoveValueChangeListener
  if (GM_HAS.registerMenuCommand) GM.registerMenuCommand = function (caption, onClick, options) { return __gmWaitReady().then(function () { return __gmRegisterMenu(caption, onClick, options) }) }
  if (GM_HAS.unregisterMenuCommand) GM.unregisterMenuCommand = __gmUnregisterMenu
  if (GM_HAS.addStyle) GM.addStyle = __gmAddStyle
  if (GM_HAS.addElement) GM.addElement = __gmAddElement
  if (GM_HAS.log) GM.log = function () { __gmLog.apply(null, arguments) }
  if (GM_HAS.notification) GM.notification = function (a, b, c) { return __gmNotify(a, b, c) }
  if (GM_HAS.setClipboard) GM.setClipboard = function (data, info) { return __gmSetClipboard(data, info) }
  if (GM_HAS.xmlHttpRequest) GM.xmlHttpRequest = function (details) {
    var d = details || {}
    return new Promise(function (resolve, reject) {
      var opts = {}
      for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) opts[k] = d[k]
      opts.onload = function (resp) { resolve(resp) }
      opts.onerror = function (resp) { reject(new Error(resp.error || '请求失败')) }
      opts.ontimeout = function () {
        var e = new Error('GM.xmlHttpRequest 请求超时')
        e.code = 'BRIDGE_TIMEOUT'
        reject(e)
      }
      __gmXhr(opts)
    })
  }
  if (GM_HAS.download) GM.download = function (input, name) { return __gmDownload(input, name) }
  if (GM_HAS.openInTab) GM.openInTab = __gmOpenInTab
  if (GM_HAS.getTab) GM.getTab = function () { return __gmSend({ c: 'tab.get' }) }
  if (GM_HAS.saveTab) GM.saveTab = function (tab) { return __gmSend({ c: 'tab.save', value: tab }) }
  if (GM_HAS.getTabs) GM.getTabs = function () { return __gmSend({ c: 'tab.all' }).then(function (v) { return v || {} }) }

  // 资源取值（TM 的 GM.* 形态是 **getResourceText / getResourceUrl** —— Url 的小写 r/l 与全局名不同，
  // 这里刻意照抄 TM，不统一大小写；虽然本该同步，但 GM.* 一律 Promise 形态）
  if (GM_HAS.getResourceText) GM.getResourceText = function (name) { return Promise.resolve(__gmResource(name, false)) }
  if (GM_HAS.getResourceUrl) GM.getResourceUrl = function (name) { return Promise.resolve(__gmResource(name, true)) }

  // GM.audio：与全局 GM_audio 是同一套方法（本来都返回 Promise），直接复用同一对象，不另写一份
  if (GM_HAS.audio) GM.audio = __gmAudioApi

  // 本扩展成员（非标准，速查页与自产 .d.ts 已标注）：恒注入，不属于任何 @grant
  GM.clearValues = function () { return __gmSend({ c: 'store.clear', connId: __gmConnId }).then(function () {
    GM_VALUES = {}
  }) }
  GM.focusTab = function (tabId) { return __gmSend({ c: 'tabs.focus', tabId: tabId }) }
  GM.page = __gmPageApi

  // —— unsafeWindow：脚本跑在页面 MAIN 世界，这里就是页面自己的 window ——
  //    直接指向 window 即可（隔离世界下才需要一个别名），无需访问告警。
  //    （注意：本文件是 TS 模板字符串，注入源码里**不能出现反引号**，否则会提前闭合模板。）
  var unsafeWindow = window

  // —— window.onurlchange（TM 形态）：属性赋值 + addEventListener('urlchange') 两种都给。
  //    监听器拦在本地、不派发真实事件（派发会经共享的 window 事件目标泄漏给页面）。——
  try {
    Object.defineProperty(window, 'onurlchange', {
      configurable: true,
      get: function () { return __gmUrlChangeHandler },
      // 纯本地：只记下回调，URL 检测（见文件末尾的 history hook）负责调它，不经 SW 订阅
      set: function (fn) { __gmUrlChangeHandler = typeof fn === 'function' ? fn : null }
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
          __gmRegSend({ c: 'tabs.close' }).catch(function (e) {
            __gmLog('window.close 失败：' + ((e && e.message) || e))
          })
        },
      })
    } catch (e) { __gmLog('window.close 挂载失败：' + ((e && e.message) || e)) }
  }
  if (GM_HAS['window.focus']) {
    try {
      Object.defineProperty(window, 'focus', {
        configurable: true,
        writable: true,
        value: function () {
          __gmRegSend({ c: 'tabs.focus' }).catch(function (e) {
            __gmLog('window.focus 失败：' + ((e && e.message) || e))
          })
        },
      })
    } catch (e) { __gmLog('window.focus 挂载失败：' + ((e && e.message) || e)) }
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
    history.pushState = function () { var r = __gmPushState.apply(this, arguments); setTimeout(__gmCheckUrl, 0); return r }
    var __gmReplaceState = history.replaceState
    history.replaceState = function () { var r = __gmReplaceState.apply(this, arguments); setTimeout(__gmCheckUrl, 0); return r }
  } catch (e) { /* 极少数环境改不动 history：退化为只看 popstate / hashchange */ }
  window.addEventListener('popstate', __gmCheckUrl)
  window.addEventListener('hashchange', __gmCheckUrl)
`
}

/**
 * 包装的闭合后缀：engine 把它拼在「`@require` 源码 ＋ 脚本源码 ＋ sourceURL 注释」之后，
 * 与本前缀合起来才是完整的一条 code（见文件头对「同一函数作用域」的说明）。
 */
export const GM_WRAPPER_SUFFIX = '\n})();'
