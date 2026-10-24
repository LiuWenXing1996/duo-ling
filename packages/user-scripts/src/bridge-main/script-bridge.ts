import {
  BRIDGE_CALL_TIMEOUT,
  BRIDGE_HANDSHAKE_TIMEOUT,
  BRIDGE_MSG_TAG,
  BRIDGE_MSG_TAG_VALUE,
  BRIDGE_PROTOCOL_VERSION,
} from '@duoling/shared'

export function buildScriptBridgeSource(secret: string, uuid: string): string {
  return `
(function () {
  var SECRET = ${JSON.stringify(secret)}
  var UUID = ${JSON.stringify(uuid)}
  var TAG = ${JSON.stringify(BRIDGE_MSG_TAG)}
  var TAG_VALUE = ${JSON.stringify(BRIDGE_MSG_TAG_VALUE)}
  var VERSION = ${JSON.stringify(BRIDGE_PROTOCOL_VERSION)}
  var HANDSHAKE_TIMEOUT = ${JSON.stringify(BRIDGE_HANDSHAKE_TIMEOUT)}
  var CALL_TIMEOUT = ${JSON.stringify(BRIDGE_CALL_TIMEOUT)}
  var _charCodeAt = String.prototype.charCodeAt
  var _imul = Math.imul
  var _numToString = Number.prototype.toString
  function __gmDigest(secret, challenge) {
    var input = secret + ':' + challenge
    var h = 0x811c9dc5
    for (var i = 0; i < input.length; i++) {
      h = _imul(h ^ _charCodeAt.call(input, i), 0x01000193) >>> 0
    }
    return ('0000000' + _numToString.call(h, 16)).slice(-8)
  }

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

  function sign(msg) {
    var s = ++seq
    msg.seq = s
    msg.proof = __gmDigest(SECRET, UUID + ':' + s)
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
    call: function (payload, runId) {
      return handshake().then(function () {
        var m = sign({ kind: 'req', req: payload, runId: runId })
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
    emit: function (payload) {
      send(sign(payload))
    },
    onEvent: function (fn) {
      if (typeof fn === 'function') eventHandlers.push(fn)
    }
  }
})();`
}
