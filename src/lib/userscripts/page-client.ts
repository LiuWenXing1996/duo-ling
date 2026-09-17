// 反向中继 · 脚本侧客户端源码模板（docs/userscript-page-relay.md v2 §4 / §6）。
//
// buildPageClientSource(pageSecret) 返回的字符串由 engine.ts 的 buildDlWrapper 内联到
// DL 包装里（USER_SCRIPT 世界），运行结果赋给 DL.page。与 page-stub.ts 成对：
// 两端共享 page-protocol.ts 的常量与 digest 片段，密钥同源（SW 注册时同一把写入）。
//
// 行为（规范 §5.3 / §6.2）：首次调用惰性握手（1s 超时）；请求按 seq 配对 reply（5s 超时）；
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
  // 注意：本源码由 buildDlWrapper 以 `var __dlPageApi = <源码>` 形式内联，
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

  // 每次文档加载一个新会话（sid 随本 IIFE 生成，规范 §5.3 防重放）
  var sid = __dlRandom()
  var seqCounter = 0
  var pending = {} // seq -> { resolve, reject, timer }
  var listeners = {} // lid -> handler(ev)
  var hookHandler = null // hook('fetch') 的裁决函数（至多一个）
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

  // —— 惰性握手（规范 §5.3）：挑战应答，验证 proof 与协议版本 ——
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
        reject(err('PAGE_STUB_UNAVAILABLE', 'DL.page 握手超时：页面世界桩不可用（检查脚本匹配规则）'))
      }, HANDSHAKE_TIMEOUT)
      function onAck(d) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (d.v !== VERSION) {
          handshakePromise = null
          return reject(err('HANDSHAKE_FAILED', 'DL.page 协议版本不符：扩展或页面脚本需要更新'))
        }
        if (d.proof !== expected) {
          handshakePromise = null
          return reject(err('HANDSHAKE_FAILED', 'DL.page 握手校验失败：页面存在冒充桩'))
        }
        resolve()
      }
      handshakeAck = onAck
      send({ kind: 'hello', challenge: challenge })
    })
    return handshakePromise
  }
  var handshakeAck = null

  // —— seq 配对的 call（规范 §6.2）——
  function call(op, extra) {
    var seq = ++seqCounter
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete pending[seq]
        reject(err('TIMEOUT', 'DL.page 调用超时：' + op))
      }, CALL_TIMEOUT)
      pending[seq] = { resolve: resolve, reject: reject, timer: timer }
      send(Object.assign({ kind: 'call', seq: seq, op: op }, extra || {}))
    })
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window) return // 只收本帧（规范 §2）
    var d = e.data
    if (!d || d[TAG] !== TAG_VALUE || d.sid !== sid) return
    if (d.kind === 'hello_ack') {
      if (handshakeAck) { var ack = handshakeAck; handshakeAck = null; ack(d) }
      return
    }
    if (d.kind === 'reply') {
      var p = pending[d.seq]
      if (!p) return // 超时后迟到的 reply：按 seq 丢弃（规范 §6.2）
      delete pending[d.seq]
      clearTimeout(p.timer)
      if (d.ok) p.resolve(d.value)
      else p.reject(err('PAGE_STUB_UNAVAILABLE', (d.value && d.value.message) || 'DL.page 调用失败'))
      return
    }
    if (d.kind === 'event') {
      var cb = listeners[d.lid]
      if (cb) { try { cb(d.ev) } catch (err2) { console.warn('[DL.page] 事件回调异常', err2) } }
      return
    }
    if (d.kind === 'hookcall') {
      var hseq = d.seq
      var settle = function (action) {
        send({ kind: 'hookreply', seq: hseq, action: action && action.action ? action : { action: 'passthrough' } })
      }
      Promise.resolve()
        .then(function () { return hookHandler ? hookHandler(d.call) : { action: 'passthrough' } })
        .then(settle)
        .catch(function () { settle({ action: 'passthrough' }) }) // 脚本异常兜底放行，不卡页面网络层
      return
    }
  })

  return {
    listen: function (type, handler, opts) {
      if (typeof handler !== 'function') return Promise.reject(err('PERMISSION_DENIED', 'DL.page.listen 需要事件回调函数'))
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
    hook: function (name, handler) {
      if (name !== 'fetch') return Promise.reject(err('PERMISSION_DENIED', 'DL.page.hook 一期仅支持 fetch（规范 §8）'))
      if (typeof handler !== 'function') return Promise.reject(err('PERMISSION_DENIED', 'DL.page.hook 需要裁决函数'))
      return handshake().then(function () {
        hookHandler = handler
        return call('hook').then(function () {
          return function () {
            return call('unhook').then(function () {
              hookHandler = null
            }, function (e) {
              // 桩已随导航消失（TIMEOUT）视为已还原；其余错误（如非 LIFO 摘除）如实上抛，
              // 且不清 hookHandler——钩子还在桩上，裁决函数不能丢
              if (e && e.code === 'TIMEOUT') { hookHandler = null; return }
              throw e
            })
          }
        })
      })
    }
  }
})();`
}
