// 反向中继 · 脚本侧客户端源码模板。
//
// buildPageClientSource(pageSecret) 返回的字符串由 gm-wrapper.ts 的 buildGmWrapperSource 内联到
// GM 包装里（USER_SCRIPT 世界），运行结果赋给 GM.page。与 page-stub.ts 成对：
// 两端共享 page-protocol.ts 的常量与 digest 片段，密钥同源（SW 注册时同一把写入）。
//
// 行为：首次调用惰性握手（1s 超时）；请求按 seq 配对 reply（5s 超时）；
// 事件按 lid 分发；hookcall 调脚本裁决后回 hookreply（脚本异常一律按 passthrough 兜底）。

import {
  PAGE_CALL_TIMEOUT,
  PAGE_DIGEST_SNIPPET,
  PAGE_HANDSHAKE_TIMEOUT,
  PAGE_MSG_TAG,
  PAGE_MSG_TAG_VALUE,
  PAGE_PROTOCOL_VERSION,
  PAGE_RANDOM_SNIPPET,
} from './page-protocol'

export function buildPageClientSource(pageSecret: string): string {
  // 注意：本源码由 buildGmWrapperSource 以 `var __dlPageApi = <源码>` 形式内联，
  // 开头不能带分号（`var x = ;` 是语法错误），也不能包 IIFE 之外的语句。
  return `
(function () {
  var SECRET = ${JSON.stringify(pageSecret)}
  var TAG = ${JSON.stringify(PAGE_MSG_TAG)}
  var TAG_VALUE = ${JSON.stringify(PAGE_MSG_TAG_VALUE)}
  var VERSION = ${JSON.stringify(PAGE_PROTOCOL_VERSION)}
  var HANDSHAKE_TIMEOUT = ${JSON.stringify(PAGE_HANDSHAKE_TIMEOUT)}
  var CALL_TIMEOUT = ${JSON.stringify(PAGE_CALL_TIMEOUT)}
  ${PAGE_DIGEST_SNIPPET}
  ${PAGE_RANDOM_SNIPPET}

  // 每次文档加载一个新会话（sid 随本 IIFE 生成，防重放）
  var sid = __dlRandom()
  var seqCounter = 0
  var pending = {} // seq -> { resolve, reject, timer }
  var listeners = {} // lid -> handler(ev)
  var hookHandler = null // fetchHook 的裁决函数（至多一个）
  var hookOnResponse = null // fetchHook 的 onResponse 回调（提供时才观察响应体）
  var handshakePromise = null

  function err(code, message) {
    var e = new Error(message || code)
    e.code = code
    return e
  }

  function send(msg) {
    msg[TAG] = TAG_VALUE
    msg.sid = sid
    try { window.postMessage(msg, window.location.origin) } catch (e) { /* 页面卸载中 */ }
  }

  // —— 惰性握手：挑战应答，验证 proof 与协议版本 ——
  function handshake() {
    if (handshakePromise) return handshakePromise
    handshakePromise = new Promise(function (resolve, reject) {
      var challenge = __dlRandom()
      var expected = __dlDigest(SECRET, challenge)
      var settled = false
      var timer = setTimeout(function () {
        if (settled) return
        settled = true
        handshakePromise = null // 失败后允许下次调用重试
        reject(err('PAGE_STUB_UNAVAILABLE', 'GM.page 握手超时：页面世界桩不可用（检查脚本匹配规则）'))
      }, HANDSHAKE_TIMEOUT)
      function onAck(d) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (d.v !== VERSION) {
          handshakePromise = null
          return reject(err('HANDSHAKE_FAILED', 'GM.page 协议版本不符：扩展或页面脚本需要更新'))
        }
        if (d.proof !== expected) {
          handshakePromise = null
          return reject(err('HANDSHAKE_FAILED', 'GM.page 握手校验失败：页面存在冒充桩'))
        }
        resolve()
      }
      handshakeAck = onAck
      send({ kind: 'hello', challenge: challenge })
    })
    return handshakePromise
  }
  var handshakeAck = null

  // —— seq 配对的 call ——
  function call(op, extra) {
    var seq = ++seqCounter
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete pending[seq]
        reject(err('TIMEOUT', 'GM.page 调用超时：' + op))
      }, CALL_TIMEOUT)
      pending[seq] = { resolve: resolve, reject: reject, timer: timer }
      send(Object.assign({ kind: 'call', seq: seq, op: op }, extra || {}))
    })
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window) return // 只收本帧
    var d = e.data
    if (!d || d[TAG] !== TAG_VALUE || d.sid !== sid) return
    if (d.kind === 'hello_ack') {
      if (handshakeAck) { var ack = handshakeAck; handshakeAck = null; ack(d) }
      return
    }
    if (d.kind === 'reply') {
      var p = pending[d.seq]
      if (!p) return // 超时后迟到的 reply：按 seq 丢弃
      delete pending[d.seq]
      clearTimeout(p.timer)
      if (d.ok) p.resolve(d.value)
      else p.reject(err('PAGE_STUB_UNAVAILABLE', (d.value && d.value.message) || 'GM.page 调用失败'))
      return
    }
    if (d.kind === 'event') {
      var cb = listeners[d.lid]
      if (cb) { try { cb(d.ev) } catch (err2) { console.warn('[GM.page] 事件回调异常', err2) } }
      return
    }
    if (d.kind === 'hookcall') {
      var hseq = d.seq
      var settle = function (action, observe) {
        send({ kind: 'hookreply', seq: hseq, action: action && action.action ? action : { action: 'passthrough' }, observe: !!observe })
      }
      Promise.resolve()
        .then(function () { return hookHandler ? hookHandler(d.call) : { action: 'passthrough' } })
        .then(function (action) { settle(action, hookOnResponse) })
        .catch(function () { settle({ action: 'passthrough' }, false) }) // 脚本异常兜底放行，不卡页面网络层
      return
    }
    if (d.kind === 'hookresponse') {
      if (hookOnResponse) { try { hookOnResponse(d.resp) } catch (err2) { console.warn('[GM.page] onResponse 回调异常', err2) } }
      return
    }
  })

  return {
    listen: function (type, handler, opts) {
      if (typeof handler !== 'function') return Promise.reject(err('PERMISSION_DENIED', 'GM.page.listen 需要事件回调函数'))
      return handshake().then(function () {
        var lid = 'L' + (++seqCounter)
        return call('listen', { lid: lid, type: String(type), selector: opts && opts.selector, once: !!(opts && opts.once) }).then(function () {
          listeners[lid] = handler
          return function () {
            delete listeners[lid]
            return call('unlisten', { lid: lid }).catch(function () { /* 桩已随导航消失，视为已注销 */ })
          }
        })
      })
    },
    fetchHook: function (handler, opts) {
      if (typeof handler !== 'function') return Promise.reject(err('PERMISSION_DENIED', 'GM.page.fetchHook 需要裁决函数'))
      var onResp = opts && typeof opts.onResponse === 'function' ? opts.onResponse : null
      return handshake().then(function () {
        hookHandler = handler
        hookOnResponse = onResp
        return call('hook').then(function () {
          return function () {
            return call('unhook').then(function () {
              hookHandler = null
              hookOnResponse = null
            }, function (e) {
              // 桩已随导航消失（TIMEOUT）视为已还原；其余错误（如非 LIFO 摘除）如实上抛，
              // 且不清 hookHandler——钩子还在桩上，裁决函数不能丢
              if (e && e.code === 'TIMEOUT') { hookHandler = null; hookOnResponse = null; return }
              throw e
            })
          }
        })
      })
    }
  }
})();`
}
