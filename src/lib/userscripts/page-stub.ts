// 反向中继 · MAIN 世界桩源码模板（docs/userscript-page-relay.md v2 §2 / §6）。
//
// buildPageStubSource(secret) 返回的字符串由 engine.ts 在注册 dl-page-stub 时
// 注入页面 MAIN 世界（world: 'MAIN'）。设计硬边界（规范 §10）：
//   - 无 chrome.*（MAIN 世界 userScript 本就没有），只靠同帧 window.postMessage；
//   - 无 new Function、不执行脚本下发的源码——纯固定逻辑机器；
//   - 与页面同级、无特权：页面看得见它做的一切，防伪只靠闭包里的 secret。
//
// 职责（一期三件）：握手应答 / listen 事件摘要转发 / hook('fetch') 调用摘要与代答。
// 每脚本 × 每帧 = 一个会话（sid），会话状态（监听表、钩子）互相隔离（规范 §5.4）。

import {
  PAGE_CALL_TIMEOUT,
  PAGE_DIGEST_SNIPPET,
  PAGE_HOOK_TIMEOUT,
  PAGE_MSG_TAG,
  PAGE_MSG_TAG_VALUE,
  PAGE_PROTOCOL_VERSION,
} from './page-protocol'

export function buildPageStubSource(secret: string): string {
  return `
;(function () {
  var SECRET = ${JSON.stringify(secret)}
  var TAG = ${JSON.stringify(PAGE_MSG_TAG)}
  var TAG_VALUE = ${JSON.stringify(PAGE_MSG_TAG_VALUE)}
  var VERSION = ${JSON.stringify(PAGE_PROTOCOL_VERSION)}
  var HOOK_TIMEOUT = ${JSON.stringify(PAGE_HOOK_TIMEOUT)}
  var CALL_TIMEOUT = ${JSON.stringify(PAGE_CALL_TIMEOUT)}
  ${PAGE_DIGEST_SNIPPET}

  // 会话表：sid -> { listeners: {lid: {type, fn}}, hook: {wrapper, prev} | null, hseq }
  // 文档卸载时本 IIFE 随 realm 消亡，无需清理（规范 §4.2 的自然清空原则）。
  var sessions = {}
  function sess(sid) {
    return sessions[sid] || (sessions[sid] = { listeners: {}, hook: null, hseq: 0 })
  }

  function send(msg) {
    msg[TAG] = TAG_VALUE
    try { window.postMessage(msg, window.location.origin) } catch (e) { /* 页面卸载中，忽略 */ }
  }

  function reply(sid, seq, ok, value) {
    send({ kind: 'reply', sid: sid, seq: seq, ok: ok, value: value })
  }

  function fail(sid, seq, message) {
    reply(sid, seq, false, { message: String((message && message.message) || message) })
  }

  // —— 事件摘要（规范 §7：只转发可克隆字段，detail 克隆失败置 null）——
  function summarizeEvent(e) {
    var ev = { type: e.type, timeStamp: e.timeStamp || 0 }
    if (typeof e.key === 'string') ev.key = e.key
    var detail = null
    try {
      if (e && typeof e === 'object' && 'detail' in e && e.detail != null) {
        detail = JSON.parse(JSON.stringify(e.detail))
      }
    } catch (_) { detail = null }
    ev.detail = detail
    return ev
  }

  // selector 过滤：target 自身命中，或沿祖先链命中（closest）——不依赖注入时刻的
  // 元素快照，元素晚于 listen 出现也能命中。
  function hitSelector(e, selector) {
    var t = e.target
    if (!t || typeof t.matches !== 'function') return false
    try { return t.matches(selector) || !!(t.closest && t.closest(selector)) } catch (_) { return false }
  }

  // —— fetch 钩子链（规范 §8）：多会话按后进先出叠 wrapper；unhook 只许从栈顶摘 ——
  var hookStack = [] // { sid, wrapper, prev }
  var origFetch = window.fetch

  function summarizeFetch(args) {
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
        if (typeof input.headers === 'object' && input.headers !== null && typeof input.headers.forEach === 'function') {
          input.headers.forEach(function (v, k) { headers[k] = String(v) })
        }
      } else {
        url = String(input)
        method = String((init && init.method) || 'GET')
        var h = init && init.headers
        if (h && typeof h === 'object' && typeof h.forEach === 'function') {
          h.forEach(function (v, k) { headers[k] = String(v) })
        } else if (h && typeof h === 'object') {
          for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) headers[k] = String(h[k])
        }
        if (init && typeof init.body === 'string') body = init.body
      }
    } catch (_) { /* 摘要失败按空值转发，不阻塞页面请求 */ }
    return { url: url, method: method, headers: headers, body: body }
  }

  function dispatchHook(session, args, next) {
    var hseq = ++session.hseq
    return new Promise(function (resolve) {
      var settled = false
      var timer
      var passthrough = function () {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { resolve(next.apply(window, args)) } catch (e) { resolve(Promise.reject(e)) }
      }
      timer = setTimeout(passthrough, HOOK_TIMEOUT) // 超时放行：宁可失效不可阻塞（规范 §8 最高优先级约束）
      // pendingHook 必须先于 send 挂好：消息投递可能同步到达，回包不能被丢。
      // 注意 settled 置位只在这两处入口各自完成，不得先置位再委托 passthrough（会自锁）。
      session.pendingHook = function (action) {
        if (settled) return
        if (action && action.action === 'respond') {
          settled = true
          clearTimeout(timer)
          try {
            resolve(new Response(action.body || '', { status: action.status || 200, headers: action.headers || {} }))
          } catch (e) {
            passthrough()
          }
        } else {
          passthrough()
        }
      }
      send({ kind: 'hookcall', sid: session.sidValue, seq: hseq, call: summarizeFetch(args) })
    })
  }
  function makeWrapper(session, prev) {
    return function () {
      var args = arguments
      return dispatchHook(session, args, prev)
    }
  }

  // —— 消息入口 ——
  window.addEventListener('message', function (e) {
    if (e.source !== window) return // 只应答本帧（规范 §2）
    var d = e.data
    if (!d || d[TAG] !== TAG_VALUE) return

    // 脚本 → hookcall 的裁决回包
    if (d.kind === 'hookreply') {
      var hs = sessions[d.sid]
      if (hs && hs.pendingHook) {
        var cb = hs.pendingHook
        hs.pendingHook = null
        cb(d.action)
      }
      return
    }

    if (d.kind === 'hello') {
      // 任何人都能收到 hello_ack——但 proof 只有持密者算得出，验方在客户端（规范 §5.3）
      send({ kind: 'hello_ack', sid: d.sid, proof: __dlDigest(SECRET, String(d.challenge || '')), v: VERSION })
      return
    }

    if (d.kind !== 'call' || typeof d.seq !== 'number') return
    var session = sess(String(d.sid))
    try {
      if (d.op === 'listen') {
        var lid = String(d.lid)
        if (session.listeners[lid]) return fail(d.sid, d.seq, 'listen id 重复')
        var selector = d.selector ? String(d.selector) : ''
        var once = !!d.once
        var fn = function (ev) {
          if (selector && !hitSelector(ev, selector)) return
          if (once) {
            delete session.listeners[lid]
            try { window.removeEventListener(d.type, fn, true) } catch (_) {}
          }
          send({ kind: 'event', sid: d.sid, lid: lid, ev: summarizeEvent(ev) })
        }
        window.addEventListener(String(d.type), fn, { capture: true, once: !!once })
        session.listeners[lid] = { type: String(d.type), fn: fn }
        return reply(d.sid, d.seq, true, null)
      }
      if (d.op === 'unlisten') {
        var l = session.listeners[String(d.lid)]
        if (l) {
          try { window.removeEventListener(l.type, l.fn, true) } catch (_) {}
          delete session.listeners[String(d.lid)]
        }
        return reply(d.sid, d.seq, true, null)
      }
      if (d.op === 'hook') {
        if (session.hook) return fail(d.sid, d.seq, '本会话已钩住 fetch')
        var prev = hookStack.length ? hookStack[hookStack.length - 1].wrapper : origFetch
        session.sidValue = String(d.sid)
        var wrapper = makeWrapper(session, prev)
        session.hook = { wrapper: wrapper, prev: prev }
        hookStack.push({ sid: String(d.sid), wrapper: wrapper, prev: prev })
        window.fetch = hookStack[hookStack.length - 1].wrapper
        return reply(d.sid, d.seq, true, null)
      }
      if (d.op === 'unhook') {
        if (!session.hook) return reply(d.sid, d.seq, true, null)
        var top = hookStack[hookStack.length - 1]
        if (!top || top.sid !== String(d.sid)) {
          return fail(d.sid, d.seq, 'unhook 只能按后进先出顺序摘除')
        }
        hookStack.pop()
        window.fetch = hookStack.length ? hookStack[hookStack.length - 1].wrapper : origFetch
        session.hook = null
        return reply(d.sid, d.seq, true, null)
      }
      return fail(d.sid, d.seq, '未知操作：' + d.op)
    } catch (err) {
      return fail(d.sid, d.seq, err)
    }
  })
})();`
}
