// 用户脚本注册引擎（v2 方案）。
//
// 主走 chrome.userScripts API：每脚本注册到独立 USER_SCRIPT 世界（worldId），
// DL 包装作为 js 数组首条目先于项目代码定义 window.DL，脚本经 onUserScriptMessage 桥接后台
// （DL 桥后台监听在 dl-bridge.ts；style / log / info / clipboard 在包装内本地实现，不走桥）。
import type { ScriptProject } from './types'
// 版本判断与「打开扩展管理页」入口同源（引导文案按 <138 / ≥138 分支，UI 侧按钮也按同一分支取 URL）
import { getChromeMajorVersion } from '@/lib/extension-page'
import * as appDb from '@/lib/app-db'
// 项目读自状态库（IndexedDB，SW 与 offscreen 共用）：注册链路不能在 offscreen 存活上下注
import { listProjects, validateMatchPatterns } from './project-store'
import { appendUserScriptError } from './store'
import { buildPageStubSource } from './page-stub'
import { buildPageClientSource } from './page-client'
import { generatePageSecret } from './page-protocol'
// 内置注入脚本共用：匹配并集与「未变则跳过」比对
import { enabledMatchUnion, sameMatchSet } from './match-union'

// 不给脚本世界配置 csp：即**不放开** eval / new Function。脚本世界因此回落浏览器默认 CSP，
// 动态执行字符串代码被禁。理由：AI 生成的脚本不可控，不额外给「执行任意字符串」的能力。
// 注入链路自身零 eval —— DL 包装 / 页面中继 / MAIN 桩均不含，
// esbuild 打 IIFE 也不产 eval，故引擎不受影响；真正受影响的只有内部用 new Function 做
// codegen 的依赖库（如 ajv 编译校验器 / Vue runtime 编译器 / handlebars 运行时模板），
// 由 collectCspWarnings 在保存时提前提示。

// —— 可用性检测 / 版本分支 ——

/** 版本无关的可用性检测：getScripts 抛错即不可用（全 Chrome 版本适用） */
export async function isUserScriptsAvailable(): Promise<boolean> {
  try {
    await chrome.userScripts.getScripts()
    return true
  } catch {
    return false
  }
}

/**
 * 引擎可用性状态：结合 isUserScriptsAvailable + UA 分支，返回结构化信息供管理页状态横幅展示。
 * - Chrome ≥138：需在扩展详情页开启「允许运行用户脚本」按扩展开关
 * - Chrome <138：需开启全局「开发者模式」
 * - Firefox：需授权 userScripts optional 权限
 */
export async function getUserScriptsStatus(): Promise<import('./types').UserScriptsAvailability> {
  const ua = navigator.userAgent
  const isFirefox = /Firefox\//.test(ua)
  const chromeMajor = getChromeMajorVersion()
  // 纯查询、无副作用：「开关被打开后补注册」的自愈在消费层（availability-watch → background），
  // 不藏在查询里——查询方（横幅 / 引导页 / 监视器）各自语义单一。
  const available = await isUserScriptsAvailable()
  let guideText = ''
  if (!available) {
    if (isFirefox) {
      guideText = 'Firefox：在扩展管理页（about:addons → 哆灵 → 偏好）勾选「User Scripts」权限后即可使用。'
    } else if (chromeMajor >= 138) {
      guideText = 'Chrome ≥138：在扩展详情页开启「允许运行用户脚本」开关后即可使用。'
    } else {
      guideText = 'Chrome <138：在 chrome://extensions 开启全局「开发者模式」后即可使用。'
    }
  }
  // 自愈：引擎可用但世界未配（权限后开 / SW 重启归零）时，按需补配世界（messaging）
  if (available && !worldsConfigured) await ensureWorldsConfigured()
  return { available, isFirefox, chromeMajor, guideText }
}

// —— 世界配置（一次性，扩展更新后需重配）——

/** 默认 USER_SCRIPT 世界是否已配置成功（messaging 已开，DL 桥可用） */
let worldsConfigured = false

/**
 * 配置指定 USER_SCRIPT 世界的 messaging —— DL 桥与错误上报的前提。
 * 返回是否配置成功；false 表示该世界没有 chrome.runtime（脚本侧 DL 调用会 reject，SW 不崩）。
 *
 * 不传 csp：脚本世界保持浏览器默认的严 CSP（禁止 eval / new Function），理由见文件头。
 *
 * 关键：worldId 省略时配置的是**默认世界**，而自定义 worldId 的世界**不会继承**默认世界的
 * 配置。我们为每个脚本用独立世界（'us-<uuid>'），因此每个脚本的世界都必须各自
 * configureWorld——否则该世界没有 chrome.runtime，DL 桥与错误上报全部失效
 * （实测症状：runtime 可用=false，脚本报错无法上报）。
 */
async function configureWorld(worldId?: string): Promise<boolean> {
  if (!chrome.userScripts || typeof chrome.userScripts.configureWorld !== 'function') {
    return false
  }
  const base = worldId ? { worldId } : {}
  try {
    await chrome.userScripts.configureWorld({ ...base, messaging: true })
    return true
  } catch (e) {
    // 配置失败：该世界无 chrome.runtime，DL 桥不可用，但 SW 不崩（脚本侧调用会 reject）
    console.warn('[duoling:userscript] 世界配置失败，DL 桥不可用', worldId ?? '(默认世界)', e)
    return false
  }
}

/** 配置默认 USER_SCRIPT 世界（启动 / 扩展更新恢复时调用） */
export async function configureUserScriptsWorld(): Promise<boolean> {
  worldsConfigured = await configureWorld()
  return worldsConfigured
}

/**
 * 确保全部世界配置就绪（自愈，幂等）：默认世界 + 已注册脚本的各自独立世界。
 *
 * 场景：「允许运行用户脚本」在扩展加载**之后**才开启——initUserScripts 跑的时候
 * chrome.userScripts 尚不存在（guard 直接跳过），各脚本世界从未 configureWorld，
 * DL 桥与错误上报全失效；MV3 SW 重启后模块级标志也会归零。故查询可用性时
 * 发现标志为 false 就按需补配全部世界。
 */
export async function ensureWorldsConfigured(): Promise<boolean> {
  await configureUserScriptsWorld()
  if (!worldsConfigured) return false
  try {
    const registered = await chrome.userScripts.getScripts()
    const worldIds = [
      ...new Set(registered.map((s) => s.worldId).filter((v): v is string => !!v)),
    ]
    for (const wid of worldIds) {
      const ok = await configureWorld(wid)
      if (!ok) console.warn('[duoling:userscript] 脚本世界配置失败（messaging）', wid)
    }
  } catch {
    // getScripts 暂不可用（权限刚开启瞬间等）时忽略，下次查询再补
  }
  return worldsConfigured
}

/**
 * 安装/保存校验：脚本世界用浏览器默认的严 CSP（禁止动态执行字符串代码），
 * 注入代码里若出现 eval / new Function，运行时会被拦截。
 * 这里产出非阻塞警告，交给 UI 提示，而非让脚本静默失败。检测对象是**注入代码**（有 bundle 用
 * bundle.code，无 bundle 用入口源码），不是项目里所有文件。
 */
export function collectCspWarnings(code: string): string[] {
  if (/\beval\s*\(|new\s+Function\s*\(/.test(code)) {
    return [
      '脚本世界默认禁止动态执行代码：脚本里的 eval / new Function 会被拦截，请改用不含它们的写法。',
    ]
  }
  return []
}

// —— DL 包装（js 首条目，先于项目代码）——
//
// DL 调后台走 chrome.runtime.sendMessage —— 因世界已 configureWorld({messaging:true})，
// USER_SCRIPT 世界的 sendMessage 会被路由到 runtime.onUserScriptMessage（非通用 onMessage）。
// 协议信封见 api-contract.ts：请求 { __dl, uuid, req } / 错误上报 { __dlEvent, uuid, name, event } /
// 运行标识广播 { __dlRunStart, uuid, runId }（侧边栏页面监控据此按 tab 登记运行）。

function buildDlWrapper(project: ScriptProject, pageSecret: string): string {
  const info = JSON.stringify({ uuid: project.uuid, name: project.name })
  // DL.page 客户端对全部脚本开放（无 pageAccess 门禁）：直接内联客户端与握手密钥
  const clientSource = buildPageClientSource(pageSecret)
  return `
;(function () {
  var DL_INFO = ${info}
  // 运行标识：**一次页面加载 = 一次运行**。注入即执行时 mint，随错误记录一起上报，
  // 并立刻广播给 SW（侧边栏页面监控据此按 tab 登记运行）。
  var __dlRunId = (function () {
    try { return crypto.randomUUID() }
    catch (e) { return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) }
  })()
  function __dlAnnounceRun() {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) return
      chrome.runtime.sendMessage({ __dlRunStart: true, uuid: DL_INFO.uuid, name: DL_INFO.name, runId: __dlRunId }, function () {
        void chrome.runtime.lastError
      })
    } catch (e) { /* 世界未开 messaging：静默（与错误上报同款兜底） */ }
  }
  __dlAnnounceRun()
  // load 时补播一次：脚本可能被配成 document_start，注入极早期的广播可能赶在
  // SW 唤醒 / 消息通道就绪前发出而丢失，靠这次补救（登记按 runId 覆盖，重复广播无害）
  if (document.readyState !== 'complete') window.addEventListener('load', __dlAnnounceRun)
  function __dlSend(req) {
    return new Promise(function (resolve, reject) {
      // 超时兜底：后台无响应时不能让 DL 调用永久挂起（表现为「既不成功也不报错」，极难排查）
      var settled = false
      var timer = setTimeout(function () {
        if (settled) return
        settled = true
        reject(new Error('DL 调用超时（后台 30s 无响应）：' + (req && req.c)))
      }, 30000)
      chrome.runtime.sendMessage({ __dl: true, uuid: DL_INFO.uuid, req: req }, function (resp) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        var err = chrome.runtime.lastError
        if (err) return reject(new Error(err.message))
        if (!resp) return reject(new Error('DL 桥无响应：' + (req && req.c)))
        if (!resp.ok) {
          var e = new Error(resp.error || 'DL 调用失败')
          if (resp.code) e.code = resp.code
          return reject(e)
        }
        resolve(resp.data)
      })
    })
  }
  // —— DL Port 事件底座（二期）——
  // 控制面（注册 / 订阅）走 sendMessage 请求-响应（__dlRegSend）；Port 只收下行推送帧。
  // lazy 连接：首次 menu.register / store.watch / notify(onClick) 时才 connect。
  // SW 注册表随 SW 冷启动归零：重连（onDisconnect → 重连 → port.ready）后重放全部活跃
  // 注册（__dlActiveMenus / __dlActiveWatches）；contextMenus 本身持久于浏览器会话，
  // 重放撞 duplicate id 由 SW 侧按成功处理（幂等）。notify 点击归属不重放（SW 内存态，
  // 重启窗口内点击丢失——拍板 ③ 接受）。
  var __dlConnId = (function () {
    try { return crypto.randomUUID() }
    catch (e) { return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) }
  })()
  var __dlPort = null
  var __dlPortReady = false
  var __dlReadyWaiters = []     // 等 port.ready 的 waiter（每个含 resolve；8s 超时自拒）
  var __dlActiveMenus = {}       // 活跃菜单注册清单（重放用）：menuId -> title
  var __dlActiveWatches = {}     // 活跃订阅清单（重放用）：key -> true
  var __dlActiveUrlWatch = false // 活跃 URL 订阅标记（重放用）
  var __dlMenuHandlers = {}      // menuId -> handler
  var __dlWatchHandlers = {}     // key -> [cb]
  var __dlNotifyHandlers = {}    // notificationId -> onClick
  var __dlUrlHandlers = []       // onUrlChange 回调清单（tab 级，不分 key）
  // 菜单 id：按「脚本 uuid + 标题」确定性生成（djb2）。菜单注册持久于浏览器会话，
  // 若用随机 id，每次页面刷新都会造新 id → 菜单无限累积；确定性 id 使同标题注册
  // 永远同 id，重放 / 重复注册撞 id 由 SW 按成功处理 → 天然去重（油猴同款语义）
  function __dlMenuId(title) {
    var h = 5381
    for (var i = 0; i < title.length; i++) h = (((h << 5) + h) + title.charCodeAt(i)) | 0
    return 'm-' + (h >>> 0).toString(36)
  }
  function __dlHandleEvent(ev) {
    if (ev.t === 'menu.click') {
      var mh = __dlMenuHandlers[ev.id]
      if (mh) { try { mh() } catch (e) { console.error('[DL:' + DL_INFO.name + '] menu 回调异常', e) } }
    } else if (ev.t === 'store.change') {
      // 删除语义（契约）：key 被 delete 后 value 置 null，与「值恰为 null」不可区分
      var cbs = __dlWatchHandlers[ev.key]
      if (cbs) for (var i = 0; i < cbs.length; i++) {
        try { cbs[i](ev.value) } catch (e) { console.error('[DL:' + DL_INFO.name + '] watch 回调异常', e) }
      }
    } else if (ev.t === 'notify.click') {
      var nh = __dlNotifyHandlers[ev.id]
      if (nh) { try { nh() } catch (e) { console.error('[DL:' + DL_INFO.name + '] notify 回调异常', e) } }
    } else if (ev.t === 'url.change') {
      // URL 变化（含 SPA 路由）：有订阅时才有事件；直接回调注册的所有 onUrlChange 监听器
      if (__dlUrlHandlers.length) {
        for (var ui = 0; ui < __dlUrlHandlers.length; ui++) {
          try { __dlUrlHandlers[ui](ev.url) } catch (e) { console.error('[DL:' + DL_INFO.name + '] onUrlChange 回调异常', e) }
        }
      }
    }
  }
  function __dlConnect() {
    if (__dlPort || !chrome || !chrome.runtime || !chrome.runtime.connect) return
    var p
    try {
      p = chrome.runtime.connect({ name: 'duoling:dl:' + DL_INFO.uuid + ':' + __dlConnId })
    } catch (e) {
      // 扩展重载后 context 失效：connect 直接抛错，放弃重试（刷新页面才是正路）
      console.warn('[DL:' + DL_INFO.name + '] Port 连接失败：' + ((e && e.message) || e))
      return
    }
    __dlPort = p
    p.onMessage.addListener(function (m) {
      if (!m || m.__dlApiEvent !== true || !m.ev) return
      if (m.ev.t === 'port.ready') {
        __dlPortReady = true
        var ws = __dlReadyWaiters.splice(0)
        for (var wi = 0; wi < ws.length; wi++) ws[wi].resolve()
        // SW 冷启动重放：注册表归零 → 重发全部活跃注册（菜单撞 id 幂等由 SW 侧处理）。
        // 与挂起的 waiter 无关：waiter 是本次连接的首发，重放是历次连接的存量
        var rreqs = []
        for (var mid in __dlActiveMenus) rreqs.push({ c: 'menu.register', id: mid, title: __dlActiveMenus[mid] })
        for (var wkey in __dlActiveWatches) rreqs.push({ c: 'store.watch', key: wkey, connId: __dlConnId })
        if (__dlActiveUrlWatch) rreqs.push({ c: 'url.watch', connId: __dlConnId })
        for (var ri = 0; ri < rreqs.length; ri++) {
          __dlSend(rreqs[ri]).catch(function (e) { console.warn('[DL:' + DL_INFO.name + '] 重放注册失败', e) })
        }
        return
      }
      __dlHandleEvent(m.ev)
    })
    p.onDisconnect.addListener(function () {
      __dlPort = null
      __dlPortReady = false
      // SW 保活常驻（拍板前提），断开只在 SW 冷启动 / 扩展重载时发生；
      // 重连本身会唤醒 SW，port.ready 回来后重放全部活跃注册，无需 SW 唤醒重连逻辑
      setTimeout(__dlConnect, 100)
    })
  }
  // 注册动作统一入口：Port 就绪立即发（真等 SW 响应）；未就绪等 port.ready 后再发
  // （消除 connect→onConnect 竞态）。MENU_OK / WATCH_OK = SW 真确认，失败/超时如实上抛。
  function __dlWaitReady() {
    if (__dlPortReady && __dlPort) return Promise.resolve()
    __dlConnect()
    return new Promise(function (resolve, reject) {
      var done = false
      var timer = setTimeout(function () {
        if (done) return
        done = true
        var i = __dlReadyWaiters.indexOf(w)
        if (i >= 0) __dlReadyWaiters.splice(i, 1)
        reject(new Error('DL Port 连接超时（8s 未就绪），去 SW Console 看「Port 已连接」日志'))
      }, 8000)
      var w = {
        resolve: function () {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve()
        }
      }
      __dlReadyWaiters.push(w)
    })
  }
  function __dlRegSend(req) {
    if (__dlPortReady && __dlPort) return __dlSend(req)
    return __dlWaitReady().then(function () { return __dlSend(req) })
  }
  function __base64ToArrayBuffer(b64) {
    var bin = atob(b64)
    var buf = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
    return buf.buffer
  }
  // 二进制请求体 → base64（分块 apply，防大数组参数超限爆栈）
  function __arrayBufferToBase64(bytes) {
    var chunk = 0x8000
    var bin = ''
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
    }
    return btoa(bin)
  }
  // 二进制请求体 → base64 信封（契约 FetchBinaryBody）：二进制无法结构化克隆过桥
  function __bytesToBase64(bytes) {
    var s = ''
    var chunk = 0x8000
    for (var i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
    }
    return btoa(s)
  }
  // 浅拷贝 init / headers（改 body 时不污染原对象，避免影响脚本后续复用）
  function __copyInit(s) {
    var c = {}
    for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) c[k] = s[k]
    return c
  }
  function __copyHeaders(h) {
    var c = {}
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) c[k] = h[k]
    return c
  }
  // 把脚本侧请求体（string/Blob/FormData/ArrayBuffer/TypedArray/DataView）编码成可跨桥的 init。
  // 返回 Promise<null | (sendInit)->newInit>：null 表示无需改动（string / 无 body）。
  function __encodeFetchBody(raw) {
    if (raw == null || typeof raw === 'string') return Promise.resolve(null)
    // Blob（含 File）：转二进制信封；有 MIME 且无手写 content-type 时代填
    if (typeof Blob !== 'undefined' && raw instanceof Blob) {
      return raw.arrayBuffer().then(function (buf) {
        var env = { __dlBinaryBody: true, base64: __bytesToBase64(new Uint8Array(buf)) }
        return function (s) {
          var c = __copyInit(s)
          c.body = env
          var t = raw.type
          if (t && (!c.headers || c.headers['content-type'] == null)) {
            c.headers = __copyHeaders(c.headers || {})
            c.headers['content-type'] = t
          }
          return c
        }
      })
    }
    // FormData：逐字段序列化（文本直传，Blob 字段转 base64 + 还原 type/filename）
    if (typeof FormData !== 'undefined' && raw instanceof FormData) {
      var fields = []
      var pending = []
      raw.forEach(function (value, name) {
        if (typeof value === 'string') {
          fields.push({ name: name, value: value })
        } else {
          pending.push(value.arrayBuffer().then(function (buf) {
            var b = new Uint8Array(buf)
            var f = typeof File !== 'undefined' && value instanceof File ? value.name : undefined
            fields.push({ name: name, base64: __bytesToBase64(b), type: value.type || 'application/octet-stream', filename: f })
          }))
        }
      })
      return Promise.all(pending).then(function () {
        return function (s) {
          var c = __copyInit(s)
          c.body = { __dlFormData: true, fields: fields }
          return c
        }
      })
    }
    // 现有二进制路径：ArrayBuffer / TypedArray / DataView
    if (typeof raw === 'object') {
      var bytes
      if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw)
      else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(raw)) bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
      else return Promise.reject(new Error('DL.fetch：body 仅支持 string / Blob / FormData / ArrayBuffer / TypedArray / DataView'))
      var env2 = { __dlBinaryBody: true, base64: __arrayBufferToBase64(bytes) }
      return Promise.resolve(function (s) { var c = __copyInit(s); c.body = env2; return c })
    }
    return Promise.reject(new Error('DL.fetch：body 仅支持 string / Blob / FormData / ArrayBuffer / TypedArray / DataView'))
  }
  // —— 反向中继客户端——
  var __dlPageApi = ${clientSource}

  var DL = {
    info: Object.freeze(DL_INFO),
    store: {
      get: function (key, fallback) { return __dlSend({ c: 'store.get', key: key, fallback: fallback }) },
      set: function (key, value) { return __dlSend({ c: 'store.set', key: key, value: value }) },
      delete: function (key) { return __dlSend({ c: 'store.delete', key: key }) },
      keys: function () { return __dlSend({ c: 'store.keys' }) },
      clear: function () { return __dlSend({ c: 'store.clear' }) },
      // 跨标签 / 跨页面监听：订阅走控制面，变化经 DL Port 推回（删除时 value 为 null）
      watch: function (key, cb) {
        if (!__dlWatchHandlers[key]) __dlWatchHandlers[key] = []
        __dlWatchHandlers[key].push(cb)
        __dlActiveWatches[key] = true
        var off = function () {
          var arr = __dlWatchHandlers[key] || []
          var i = arr.indexOf(cb)
          if (i >= 0) arr.splice(i, 1)
          if (!arr.length) {
            delete __dlWatchHandlers[key]
            delete __dlActiveWatches[key]
            __dlRegSend({ c: 'store.unwatch', key: key, connId: __dlConnId }).catch(function () {})
          }
        }
        // 等 SW 真挂上订阅才 resolve——WATCH_OK 必须代表订阅已生效
        return __dlRegSend({ c: 'store.watch', key: key, connId: __dlConnId }).then(function () { return off })
      }
    },
    // 免 CORS 请求：后台 SW 发起，不受页面 CSP 与同源策略限制；非 2xx 不抛错，看 r.ok。
    // 请求体：string / Blob / FormData / ArrayBuffer / TypedArray / DataView。
    // 二进制没法直接过桥——Blob/ArrayBuffer 转 base64 信封、FormData 逐字段序列化成信封，
    // 由 SW 侧解码重建（FormData 的 multipart boundary 由浏览器生成）。
    fetch: function (url, init) {
      var sendInit = init || {}
      return __encodeFetchBody(sendInit.body).then(function (encode) {
        var finalInit = encode ? encode(sendInit) : sendInit
        return __dlSend({ c: 'fetch', url: url, init: finalInit }).then(function (p) {
          return {
            ok: p.ok,
            status: p.status,
            statusText: p.statusText,
            headers: p.headers,
            url: p.url,
            text: function () { return p.body },
            json: function () { return JSON.parse(p.body) },
            arrayBuffer: function () { return __base64ToArrayBuffer(p.body) },
            blob: function () {
              if (p.responseType !== 'arraybuffer') {
                throw new Error("DL.fetch().blob() 不可用：需先设置 responseType: 'arraybuffer'（默认 text 模式字节已被 UTF-8 解码破坏）")
              }
              return new Blob([__base64ToArrayBuffer(p.body)], { type: (p.headers && p.headers['content-type']) || '' })
            }
          }
        })
      })
    },
    // 读取保存期内联的资源（builder 把非 JS 依赖打成 DL.__res 表随 bundle 注入）。
    // 纯本地读表，不走桥；类型不符 / 未内联明确报错，不静默。
    resource: function (url, opts) {
      var R = DL.__res || {}
      var e = R[url]
      if (!e) {
        return Promise.reject(new Error('DL.resource：资源未内联（未加入依赖列表或保存时未成功拉取）：' + url))
      }
      if (opts && opts.base64) {
        if (e.b64 != null) return Promise.resolve(e.b64)
        return Promise.reject(new Error('DL.resource：该资源是文本，直接 DL.resource(url) 即可：' + url))
      }
      if (e.text != null) return Promise.resolve(e.text)
      return Promise.reject(new Error('DL.resource：该资源是二进制，请用 DL.resource(url, { base64: true })：' + url))
    },
    // 系统通知。带 onClick 时按响应里的通知 id 挂回调，点击经 DL Port 回推
    notify: function (message, opts) {
      return __dlSend({ c: 'notify', message: message, title: opts && opts.title, icon: opts && opts.icon }).then(function (r) {
        if (opts && opts.onClick && r && r.id) __dlNotifyHandlers[r.id] = opts.onClick
        return undefined
      })
    },
    // 触发下载：
    //   - string = 远程 URL（SW 抓取转 dataUrl，触发 a[download]）
    //   - Blob / ArrayBuffer / TypedArray = 本地直下（纯包装层 createObjectURL + a[download]，不走桥）
    download: function (input, name) {
      if (typeof input === 'string') {
        return __dlSend({ c: 'download', url: input, name: name }).then(function (r) {
          var a = document.createElement('a')
          a.href = r.dataUrl; a.download = r.name
          ;(document.body || document.documentElement).appendChild(a)
          a.click(); a.remove()
        })
      }
      var blob
      if (input instanceof Blob) {
        blob = input
      } else if (input instanceof ArrayBuffer) {
        blob = new Blob([input])
      } else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(input)) {
        // TypedArray / DataView：只取视图自己的字节段（大 buffer 上的局部视图不整个发）
        blob = new Blob([new Uint8Array(input.buffer, input.byteOffset, input.byteLength)])
      } else {
        return Promise.reject(new Error('DL.download：首参仅支持 string(URL) / Blob / ArrayBuffer / TypedArray'))
      }
      var url = URL.createObjectURL(blob)
      try {
        var a = document.createElement('a')
        a.href = url; a.download = name || 'download'
        ;(document.body || document.documentElement).appendChild(a)
        a.click(); a.remove()
      } finally {
        // 点击后稍延释放，避免部分浏览器在 blob 被回收后才开始下载
        setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
      }
      return Promise.resolve()
    },
    // 剪贴板：走 offscreen 桥（免用户手势）；富文本走 writeHtml
    clipboard: {
      write: function (text) {
        return __dlSend({ c: 'clipboard.write', text: text }).then(function () { return undefined })
      },
      writeHtml: function (html, plainText) {
        return __dlSend({ c: 'clipboard.write', text: plainText, html: html }).then(function () { return undefined })
      }
    },
    tabs: {
      open: function (url, opts) { return __dlSend({ c: 'tabs.open', url: url, active: !!(opts && opts.active) }) },
      close: function (tabId) { return __dlSend({ c: 'tabs.close', tabId: tabId }) },
      focus: function (tabId) { return __dlSend({ c: 'tabs.focus', tabId: tabId }) }
    },
    // 标签页级存储（对齐 GM_getTab 系列）：tabId 由 SW 从 sender.tab.id 取，随 tab 生命周期清理
    tab: {
      get: function () { return __dlSend({ c: 'tab.get' }) },
      save: function (value) { return __dlSend({ c: 'tab.save', value: value }) },
      all: function () { return __dlSend({ c: 'tab.all' }) }
    },
    // 扩展菜单（contextMenus）：后台登记，点击经 DL Port 回推（只推点击所在 tab）
    menu: {
      register: function (title, handler) {
        var t = typeof title === 'string' && title ? title : '菜单项'
        var id = __dlMenuId(t)
        __dlMenuHandlers[id] = handler
        __dlActiveMenus[id] = t
        // 等 SW 真建好菜单才 resolve——MENU_OK 必须代表菜单已在位
        return __dlRegSend({ c: 'menu.register', id: id, title: t }).then(function () {
          return function () {
            delete __dlMenuHandlers[id]
            delete __dlActiveMenus[id]
            __dlRegSend({ c: 'menu.unregister', id: id }).catch(function () {})
          }
        })
      }
    },
    // cookie（cookies 权限）：**url 缺省由本包装层填 location.href** —— SW 里没有「当前页面」概念。
    // 这里只补默认值、不做任何安全判断：域名门在 SW 侧（cookie-gate.ts），
    // 包装层传什么 url 都要过门（包装层跑在页面里，参数与身份都不可信）。
    cookie: {
      get: function (query) {
        var q = query || {}
        return __dlSend({ c: 'cookie.get', url: q.url || location.href, name: q.name })
      },
      set: function (details) {
        var d = details || {}
        return __dlSend({
          c: 'cookie.set',
          url: d.url || location.href,
          name: d.name,
          value: d.value,
          secure: d.secure,
          httpOnly: d.httpOnly,
          expirationDate: d.expirationDate
        })
      },
      remove: function (details) {
        var d = details || {}
        return __dlSend({ c: 'cookie.remove', url: d.url || location.href, name: d.name })
      }
    },
    // 本地能力（不跨桥）
    style: function (css) {
      var el = document.createElement('style')
      el.textContent = css
      ;(document.head || document.documentElement).appendChild(el)
      return el
    },
    // URL 变化订阅（SPA 路由感知）：走控制面 url.watch，事件经 DL Port 推回 t:'url.change'
    onUrlChange: function (cb) {
      __dlUrlHandlers.push(cb)
      __dlActiveUrlWatch = true
      var off = function () {
        var i = __dlUrlHandlers.indexOf(cb)
        if (i >= 0) __dlUrlHandlers.splice(i, 1)
        if (!__dlUrlHandlers.length) {
          __dlActiveUrlWatch = false
          __dlRegSend({ c: 'url.unwatch', connId: __dlConnId }).catch(function () {})
        }
      }
      // 等 SW 真挂上订阅才 resolve——WATCH_OK 必须代表订阅已生效
      return __dlRegSend({ c: 'url.watch', connId: __dlConnId }).then(function () { return off })
    },
    log: function () {
      console.log.apply(console, ['[DL:' + DL_INFO.name + ']'].concat([].slice.call(arguments)))
    },
    page: __dlPageApi
  }
  window.DL = DL

  // 运行期错误收集（错误日志面板）：本世界的未捕获异常 / 未处理 Promise 拒绝
  // 经 { __dlEvent: true, event: DlEvent } 转发到后台（世界已 configureWorld({messaging:true})）。
  function __dlReportError(message, stack, url) {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        console.warn('[duoling:userscript] 世界未开启 messaging，运行期错误无法上报：' + message)
        return
      }
      chrome.runtime.sendMessage(
        { __dlEvent: true, uuid: DL_INFO.uuid, name: DL_INFO.name, event: { t: 'error', phase: 'runtime', message: message, stack: stack, url: url, runId: __dlRunId } },
        function () {
          var le = chrome.runtime.lastError
          if (le) console.warn('[duoling:userscript] 运行期错误上报失败：' + le.message)
        },
      )
    } catch (e) {
      console.warn('[duoling:userscript] 上报异常：' + ((e && e.message) || e))
    }
  }
  window.addEventListener('error', function (e) {
    var err = e.error || {}
    __dlReportError(e.message || 'Script error', (err && err.stack) || '', location.href)
  })
  window.addEventListener('unhandledrejection', function (e) {
    var r = (e && e.reason) || {}
    __dlReportError('Unhandled rejection: ' + ((r && r.message) || String(e.reason)), (r && r.stack) || '', location.href)
  })
})();
`
}

// —— 注入代码解析（产物不变量：SW 只注册最终产物，没有直跑源码的逻辑）——

/**
 * 取实际注入的代码：**只认 bundle.code**。
 * 无产物直接抛错（注册失败降级为 registerError 警告），绝不把未构建的源码注入页面——
 * 新建 / 安装在写侧（project-write）已先构建出产物，能走到注册的项目必有 bundle。
 */
export function resolveInjectCode(project: ScriptProject): string {
  if (!project.bundle?.code) {
    throw new Error('脚本没有构建产物：注入代码只来自构建（编辑器保存 / 历史恢复会自动构建）')
  }
  return project.bundle.code
}

/** DevTools 里的脚本显示名：duoling://script/<uuid>/<安全化的项目名>.js */
function sourceURLSuffix(project: ScriptProject): string {
  const safeName = project.name.replace(/[^\w.-]/g, '_') || 'script'
  return `\n//# sourceURL=duoling://script/${project.uuid}/${safeName}.js`
}

// —— 反向中继 stub 注册——

/** MAIN 世界共享桩的注册 ID：一个扩展一份，不是每脚本一份 */
export const PAGE_STUB_ID = 'dl-page-stub'
/** stubSecret 持久化键：MV3 SW 随时休眠，模块变量会归零，密钥必须落盘（duoling-app 库） */
const PAGE_SECRET_KEY = 'pageSecret'

/** 密钥模块缓存（SW 存活期内复用，避免每次注册都读存储） */
let pageSecretCache = ''

async function getOrCreatePageSecret(): Promise<string> {
  if (pageSecretCache) return pageSecretCache
  try {
    const stored = await appDb.get<string>(PAGE_SECRET_KEY)
    if (stored) {
      pageSecretCache = stored
      return pageSecretCache
    }
  } catch {
    // 存储不可用则退化为一次性密钥（仅本次 SW 存活期有效）
  }
  pageSecretCache = generatePageSecret()
  try {
    await appDb.set(PAGE_SECRET_KEY, pageSecretCache)
  } catch {
    // 写不进就只用缓存值：SW 重启后会换新密钥，脚本与桩在同一遍注册里仍保持一致
  }
  return pageSecretCache
}

/**
 * 轮换密钥（扩展 install/update 恢复时调用，「重注册即轮换」的落点）。
 * 轮换后必须紧跟着 registerAllEnabled：桩与全部启用脚本包装在同一遍里带上新密钥。
 */
export async function rotatePageSecret(): Promise<void> {
  pageSecretCache = generatePageSecret()
  await appDb.set(PAGE_SECRET_KEY, pageSecretCache).catch(() => {})
}

/**
 * 按并集维护 MAIN 世界共享桩（幂等可重入；调用方负责串行化）。
 * 匹配并集未变且桩已在位时跳过重注册——重注册会换注入源码，已加载页面要到下次导航才换新，
 * 无谓重注册只会扩大「桩与脚本包装密钥不同代」的窗口。
 * 并集为空 → 注销桩。并集算法与比对在 match-union.ts。
 */
async function syncPageStubUnion(projects: ScriptProject[]): Promise<void> {
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') return
  const union = enabledMatchUnion(projects)
  let existing: chrome.userScripts.RegisteredUserScript | undefined
  try {
    existing = (await chrome.userScripts.getScripts()).find((s) => s.id === PAGE_STUB_ID)
  } catch {
    return // 引擎不可用时静默跳过（上层已有状态横幅兜底）
  }
  if (!union) {
    console.log('[duoling:sw] 桩并集为空，注销 MAIN 桩')
    if (existing) await chrome.userScripts.unregister({ ids: [PAGE_STUB_ID] }).catch(() => {})
    return
  }
  if (existing && sameMatchSet(existing, union)) {
    console.log('[duoling:sw] MAIN 桩已在位且并集未变，跳过')
    return
  }
  const secret = await getOrCreatePageSecret()
  await chrome.userScripts.unregister({ ids: [PAGE_STUB_ID] }).catch(() => {})
  const stub: chrome.userScripts.RegisteredUserScript = {
    id: PAGE_STUB_ID,
    world: 'MAIN',
    js: [{ code: buildPageStubSource(secret) }],
    matches: union.matches,
    excludeMatches: union.excludeMatches,
    includeGlobs: union.includeGlobs,
    excludeGlobs: union.excludeGlobs,
    // document_start：必须早于脚本默认的 document_end 握手窗口
    runAt: 'document_start',
    allFrames: true,
    // userScripts API 无 persistAcrossSessions（那是 contentScripts 的字段，Chrome 会报
    // Unexpected property）；userScripts 注册本身即跨 SW 会话持久，仅扩展更新后需重注册
    // （recoverOnUpdate 已覆盖）。
  }
  try {
    await chrome.userScripts.register([stub])
    console.log('[duoling:sw] MAIN 桩注册成功：', JSON.stringify(union.matches))
  } catch (e) {
    console.warn('[duoling:sw] MAIN 桩注册失败：', e)
    throw e
  }
}

/**
 * 重算**内置注入脚本**的注册（挂 registerChain 串行队列）：脚本增删改 / 启停 / 删除后由 background 调用。
 * 当前唯一一份内置注册：DL.page MAIN 桩（world: 'MAIN'，页面世界能力代理）。
 */
export function refreshBuiltinScripts(): Promise<void> {
  const run = registerChain.then(async () => {
    const projects = await listProjects()
    await syncPageStubUnion(projects)
  })
  registerChain = run.catch(() => {})
  return run
}

// —— 注册 / 注销 ——

/**
 * 单条注册（仅 enabled 项目才注入；matches 缺失直接抛错）。
 * js 顺序：DL 包装 → 构建产物（resolveInjectCode，无产物即抛错）。
 */
export async function registerScript(project: ScriptProject): Promise<void> {
  if (!project.enabled) return
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') {
    throw new Error('userScripts 引擎不可用：Chrome ≥138 需在扩展详情页开启「Allow User Scripts」，Chrome <138 需开启全局「开发者模式」，Firefox 需授权 userScripts 权限')
  }
  if (!project.config.matches?.length) {
    throw new Error('脚本缺少匹配规则（matches），无法注册')
  }
  // match pattern 合法性：与导入路径共用同一校验器，
  // 非法值在此以中文报错拦下，不再拖到 chrome.userScripts.register 才以英文异常冒出
  validateMatchPatterns(project.config)
  const code = resolveInjectCode(project) + sourceURLSuffix(project)
  // 密钥取自持久层（与 MAIN 桩同源）：单脚本注册路径（create/updateFiles/toggle）也可能
  // 在 SW 刚唤醒、尚未跑过 registerAllEnabled 时发生，必须能独立取到当前密钥。
  const pageSecret = await getOrCreatePageSecret()
  const js: chrome.userScripts.RegisteredUserScript['js'] = [
    { code: buildDlWrapper(project, pageSecret) },
    { code },
  ]
  const worldId = 'us-' + project.uuid // 每脚本独立世界，实现全局隔离（要求 Chrome 133+）
  // 该脚本的独立世界必须先单独开 messaging，否则世界内没有 chrome.runtime，
  // DL 桥与运行期错误上报全部失效（自定义世界不继承默认世界配置）。
  // 注意：不能覆盖全局 worldsConfigured——那是**默认世界**的状态（供可用性查询自愈判断）；
  // 单世界失败只影响该脚本自身，记入错误日志而非污染全局标志。
  const worldOk = await configureWorld(worldId)
  if (!worldOk) {
    console.warn('[duoling:userscript] 脚本世界配置失败（无 messaging，DL 桥不可用）', worldId)
    void appendUserScriptError({
      uuid: project.uuid,
      name: project.name,
      phase: 'register',
      message: '独立世界配置失败：该脚本的 DL 桥与错误上报不可用（世界未开启 messaging）',
    }).catch(() => {})
  }
  const userScript: chrome.userScripts.RegisteredUserScript = {
    id: project.uuid,
    worldId,
    js,
    matches: project.config.matches,
    excludeMatches: project.config.excludeMatches,
    includeGlobs: project.config.includeGlobs,
    excludeGlobs: project.config.excludeGlobs,
    runAt: project.config.runAt,
    allFrames: project.config.allFrames,
  }
  // 幂等保护：dev 重载 / SW 顶层 init 与 onInstalled(update) 并发时，同 ID 可能已注册，
  // 直接 register 会抛 Duplicate script ID。先清旧再注册（不存在时 unregister 静默成功）。
  await chrome.userScripts.unregister({ ids: [project.uuid] }).catch(() => {})
  await chrome.userScripts.register([userScript])
}

/**
 * 注销指定 id（ids 为空直接跳过）。
 *
 * Chrome 的 unregister 批量语义是**整批原子**：ids 里混进任何一个已不在册的 id
 * （状态库与注册表短暂不一致属常态），整批抛 "Nonexistent script ID"、一个都不注销，
 * 其余在册的就此成幽灵（2026-09-20 手测实锤：14 个 uuid 只有 1 个在册，批量注销
 * 恒失败）。故先 getScripts 取交集，只注销真实在册的；不在册的本来就无需注销。
 */
export async function unregisterScripts(ids: string[]): Promise<void> {
  if (!ids.length) return
  if (!chrome.userScripts || typeof chrome.userScripts.unregister !== 'function') return
  const existing = new Set((await chrome.userScripts.getScripts()).map((s) => s.id))
  const live = ids.filter((id) => existing.has(id))
  if (!live.length) return
  await chrome.userScripts.unregister({ ids: live })
}

// 串行化：dev 重载时 SW 顶层 init 与 onInstalled(update) 可能并发触发注册，
// 两次 registerAllEnabled 交叠（各自 getScripts→unregister→register）会互相踩踏。
let registerChain: Promise<void> = Promise.resolve()

/** 从 storage 读回全部启用项目重新注册（幂等：先清已注册再重注册；并发调用自动串行） */
export function registerAllEnabled(): Promise<void> {
  const run = registerChain.then(runRegisterAllEnabled)
  registerChain = run.catch(() => {})
  return run
}

async function runRegisterAllEnabled(): Promise<void> {
  const projects = await listProjects()
  // 先同步内置注册（启用脚本集合可能变化），再重注册脚本——同一遍里保持桩与包装密钥一致
  await syncPageStubUnion(projects).catch(() => {})
  const enabled = projects.filter((p) => p.enabled)
  try {
    const existing = await chrome.userScripts.getScripts()
    // 全量重注册只清用户脚本——内置注册（MAIN 桩）在上一行刚按并集同步过，不能被这把误清
    const stale = existing.filter((s) => s.id !== PAGE_STUB_ID)
    if (stale.length) await unregisterScripts(stale.map((s) => s.id))
  } catch {
    // 可用性未恢复时 getScripts 抛错，忽略（上层已检测）
  }
  // 环境 / 权限不可用：全员注册必然失败，但那不属于任何脚本本身的错，
  // 不要给每个脚本写一条 register 错误（会误导成「所有脚本都有问题」）；环境状态由列表页横幅兜底
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') return
  for (const project of enabled) {
    try {
      await registerScript(project)
    } catch (e) {
      console.error('[duoling:userscript] 注册失败', project.uuid, e)
      void appendUserScriptError({
        uuid: project.uuid,
        name: project.name,
        phase: 'register',
        message: e instanceof Error ? e.message : String(e),
      }).catch(() => {})
    }
  }
}

/**
 * 扩展更新恢复：userScripts 注册与 world 配置在扩展更新时都会被清空。
 * 顺序必须：先 configureWorld 再 register（world 没配好脚本 messaging 会失败）。
 */
export async function recoverOnUpdate(): Promise<void> {
  await configureUserScriptsWorld()
  // 扩展 install/update：轮换握手密钥（旧注册已被浏览器清空），随后的 registerAllEnabled
  // 会把桩与全部启用脚本包装在同一遍里带上新密钥（重注册即轮换）
  await rotatePageSecret().catch(() => {})
  await registerAllEnabled()
}
