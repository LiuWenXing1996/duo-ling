// 脚本主世界桥 · MAIN 世界侧客户端源码模板。
//
// buildScriptBridgeSource(secret, uuid) 返回的字符串由 gm-wrapper.ts 以
// `var __dlBridge = <源码>` 内联进 GM 包装，运行在**页面 MAIN 世界**。
//
// 职责：给同一份包装里的 GM 能力实现当「`chrome.runtime` 的替身」——
//   · `call(req)` 请求-应答，对应原先的 `chrome.runtime.sendMessage` 回调式调用；
//   · `connect(connId)` 建下行通道，对应 `chrome.runtime.connect`（事件由中继件转回来）；
//   · `onEvent(fn)` 收下行帧。
//
// 传输层只做「发出去、按 seq 配回、超时兜底」，`resp.ok` 那层业务判断留在调用方
// （包装里的 `__gmSend`），桥本身不解释语义。
//
// 密钥与中继件同源（SW 注册时同一把写入，见 engine.ts）；每条消息带
// `digest(secret, uuid:seq)`，见 bridge-protocol.ts 的说明。

import {
  BRIDGE_CALL_TIMEOUT,
  BRIDGE_DIGEST_SNIPPET,
  BRIDGE_HANDSHAKE_TIMEOUT,
  BRIDGE_MSG_TAG,
  BRIDGE_MSG_TAG_VALUE,
  BRIDGE_PROTOCOL_VERSION,
} from './bridge-protocol'

export function buildScriptBridgeSource(secret: string, uuid: string): string {
  // 注意：本源码由 buildGmWrapperSource 以 `var __dlBridge = <源码>` 形式内联，
  // 开头不能带分号（`var x = ;` 是语法错误）。
  return `
(function () {
  var SECRET = ${JSON.stringify(secret)}
  var UUID = ${JSON.stringify(uuid)}
  var TAG = ${JSON.stringify(BRIDGE_MSG_TAG)}
  var TAG_VALUE = ${JSON.stringify(BRIDGE_MSG_TAG_VALUE)}
  var VERSION = ${JSON.stringify(BRIDGE_PROTOCOL_VERSION)}
  var HANDSHAKE_TIMEOUT = ${JSON.stringify(BRIDGE_HANDSHAKE_TIMEOUT)}
  var CALL_TIMEOUT = ${JSON.stringify(BRIDGE_CALL_TIMEOUT)}
  ${BRIDGE_DIGEST_SNIPPET}

  // seq 单调递增：既是请求配对键，也是 proof 的变量（防重放靠中继件侧的 seq 检查）
  var seq = 0
  var pending = {}          // seq -> { resolve, timer }
  var eventHandlers = []
  var handshakePromise = null
  var handshakeAck = null

  function err(code, message) {
    var e = new Error(message || code)
    e.code = code
    return e
  }

  function send(msg) {
    msg[TAG] = TAG_VALUE
    msg.uuid = UUID
    try { window.postMessage(msg, window.location.origin) } catch (e) { /* 页面卸载中，忽略 */ }
  }

  /** 给消息签上序号与 proof（就地加字段，不复制对象——省一次遍历） */
  function sign(msg) {
    var s = ++seq
    msg.seq = s
    msg.proof = __dlBridgeDigest(SECRET, UUID + ':' + s)
    return msg
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window) return // 只收本帧
    var d = e.data
    if (!d || d[TAG] !== TAG_VALUE) return
    if (d.uuid !== UUID) return // 同帧可能有别的脚本，中继件是共用的，只认自己那份

    if (d.kind === 'hello_ack') {
      if (handshakeAck) { var ack = handshakeAck; handshakeAck = null; ack(d) }
      return
    }
    if (d.kind === 'res') {
      var p = pending[d.seq]
      if (!p) return // 超时后迟到的应答：按 seq 丢弃
      delete pending[d.seq]
      clearTimeout(p.timer)
      p.resolve(d.resp)
      return
    }
    if (d.kind === 'ev') {
      for (var i = 0; i < eventHandlers.length; i++) {
        try { eventHandlers[i](d.ev) } catch (e2) { /* 回调异常不拖垮桥 */ }
      }
    }
  })

  // —— 惰性握手：确认中继件在。缺失时给明确错误，而不是让首次调用白等 30s ——
  function handshake() {
    if (handshakePromise) return handshakePromise
    handshakePromise = new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        handshakePromise = null // 失败后允许下次调用重试
        reject(err('BRIDGE_UNAVAILABLE', '脚本桥握手超时：页面世界的中继件不可用（检查脚本匹配规则）'))
      }, HANDSHAKE_TIMEOUT)
      handshakeAck = function (d) {
        clearTimeout(timer)
        if (d.v !== VERSION) {
          handshakePromise = null
          return reject(err('BRIDGE_VERSION_MISMATCH', '脚本桥协议版本不符：请刷新页面（扩展可能已更新）'))
        }
        resolve()
      }
      send(sign({ kind: 'hello' }))
    })
    return handshakePromise
  }

  return {
    call: function (payload) {
      return handshake().then(function () {
        var m = sign({ kind: 'req', req: payload })
        return new Promise(function (resolve, reject) {
          var timer = setTimeout(function () {
            delete pending[m.seq]
            reject(err('BRIDGE_TIMEOUT', 'GM 调用超时（30s 无响应）：' + (payload && payload.c)))
          }, CALL_TIMEOUT)
          pending[m.seq] = { resolve: resolve, timer: timer }
          send(m)
        })
      })
    },
    connect: function (connId) {
      return handshake().then(function () {
        send(sign({ kind: 'connect', connId: connId }))
      })
    },
    onEvent: function (fn) {
      if (typeof fn === 'function') eventHandlers.push(fn)
    }
  }
})();`
}
