// 网络录制 · MAIN 世界捕获件源码模板。
//
// buildNetRecorderSource() 返回的字符串由 engine.ts 在注册 dl-net-recorder 时注入页面
// MAIN 世界（world: 'MAIN'）。为什么必须 MAIN：要拦页面**自己**发出的 fetch/XHR，
// 钩子只能挂在页面世界——USER_SCRIPT 世界是独立 realm，挂它的 window.fetch 拦不到。
//
// 设计硬边界（与 page-stub.ts 同款）：
//   - 无 chrome.*（MAIN 世界本就没有），捕获后只靠同帧 window.postMessage 交给转发件；
//   - 与页面同级、无特权：页面看得见它做的一切；
//   - **不阻塞页面网络层**：所有采样都在响应返回之后异步做，绝不 await 在请求路径上。
//
// 隐私：请求 / 响应头里的鉴权字段一律剥离（见 net-record-protocol.ts 的名单），
// 请求体与响应体都只留 ≤NET_BODY_LIMIT 的采样（二进制标 '[binary]'）。

import { NET_AUTH_HEADER_NAMES, NET_BODY_LIMIT, NET_CAPTURE_TAG } from './net-record-protocol'

export function buildNetRecorderSource(): string {
  return `
;(function () {
  var TAG = ${JSON.stringify(NET_CAPTURE_TAG)}
  var LIMIT = ${JSON.stringify(NET_BODY_LIMIT)}
  var AUTH = ${JSON.stringify([...NET_AUTH_HEADER_NAMES])}
  // 幂等：同一 realm 里被注入两次也只包一层（防重复注册 / 导航竞态）
  if (window.__dlNetRecorder) return
  window.__dlNetRecorder = true

  var AUTH_SET = {}
  for (var ai = 0; ai < AUTH.length; ai++) AUTH_SET[AUTH[ai]] = true

  function origin() {
    try { return window.location.origin || '*' } catch (e) { return '*' }
  }
  function emit(capture) {
    try { window.postMessage({ __dlNetCapture: true, capture: capture }, origin()) } catch (e) { /* 页面卸载中 */ }
  }
  function now() { return Date.now() }

  // —— 公共采样工具 ——

  function truncate(s) {
    if (typeof s !== 'string') return null
    return s.length <= LIMIT ? s : s.slice(0, LIMIT)
  }
  function stripAuth(obj) {
    var out = {}
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue
      if (!AUTH_SET[String(k).toLowerCase()]) out[k] = obj[k]
    }
    return out
  }
  // headers 可能是 Headers / [[k,v]] / 普通对象；键统一小写（全链路唯一规范形式，见 net-record-protocol）
  function headerList(h) {
    var out = {}
    try {
      if (!h) return out
      if (typeof h.forEach === 'function') { h.forEach(function (v, k) { out[String(k).toLowerCase()] = String(v) }); return out }
      if (Array.isArray(h)) { for (var i = 0; i < h.length; i++) out[String(h[i][0]).toLowerCase()] = String(h[i][1]); return out }
      if (typeof h === 'object') { for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) out[String(k).toLowerCase()] = String(h[k]) }
    } catch (e) { /* 摘要失败按空头处理 */ }
    return out
  }
  // XHR 的 getAllResponseHeaders() 返回 CRLF 分隔的原始文本，需单独解析
  function parseRawHeaders(text) {
    var out = {}
    try {
      var lines = String(text || '').split(/\\r?\\n/)
      for (var i = 0; i < lines.length; i++) {
        var idx = lines[i].indexOf(':')
        if (idx <= 0) continue
        var name = lines[i].slice(0, idx).trim().toLowerCase()
        var value = lines[i].slice(idx + 1).trim()
        if (name) out[name] = value
      }
    } catch (e) {}
    return out
  }
  function resolveUrl(u) {
    try { return new URL(String(u), (window.location && window.location.href) || undefined).href } catch (e) { return String(u) }
  }
  function blank(type, url, method) {
    return { type: type, url: url || '', method: (method || 'GET').toUpperCase(), reqHeaders: {}, reqBody: null, status: 0, respHeaders: {}, respBody: null, t: 0 }
  }

  // 限量读流（≤ LIMIT 字符即取消），避免为大响应体把内存读爆
  function readCapped(stream, limit) {
    return new Promise(function (resolve) {
      var chunks = []
      var total = 0
      var done = false
      function finish() { if (done) return; done = true; resolve(chunks.join('')) }
      try {
        if (!stream || typeof stream.getReader !== 'function') { resolve(''); return }
        var reader = stream.getReader()
        var decoder = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8') : null
        function pump() {
          reader.read().then(function (r) {
            if (done) return
            if (r.done) { finish(); return }
            var chunk = r.value
            var s = ''
            if (typeof chunk === 'string') s = chunk
            else if (chunk && typeof chunk.byteLength === 'number') {
              var bytes = chunk
              if (total + chunk.byteLength > limit && typeof chunk.subarray === 'function') {
                bytes = chunk.subarray(0, Math.max(0, limit - total))
              }
              try { s = decoder ? decoder.decode(bytes, { stream: true }) : '' } catch (e) { s = '' }
            }
            total += s.length
            chunks.push(s)
            if (total >= limit) { try { reader.cancel() } catch (e) { /* 已读完 */ } finish(); return }
            pump()
          }).catch(function () { finish() })
        }
        pump()
        setTimeout(finish, 5000) // 流半天不结束也别挂着
      } catch (e) { finish() }
    })
  }

  // 响应体的「结构摘要」：能解析成 JSON 就出形状（键 + 小样本值），否则退回截断原文
  function shapeOf(v, depth) {
    if (v === null) return 'null'
    if (Array.isArray(v)) {
      if (!v.length) return '[]'
      return '[' + shapeOf(v[0], depth + 1) + ' ×' + v.length + ']'
    }
    var t = typeof v
    if (t === 'object') {
      if (depth > 4) return '{…}'
      var keys = Object.keys(v)
      if (keys.length > 30) keys = keys.slice(0, 30)
      return '{ ' + keys.map(function (k) { return k + ': ' + shapeOf(v[k], depth + 1) }).join(', ') + ' }'
    }
    if (t === 'string') return JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v)
    return t
  }
  function summarizeBody(text) {
    if (text == null || text === '') return null
    var t = String(text)
    try { return truncate(shapeOf(JSON.parse(t), 0)) } catch (e) { return truncate(t) }
  }

  // —— fetch 钩子（只包一层；保留原 fetch 的 this 与参数）——
  var origFetch = window.fetch
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var beg
      try {
        var info = blank('fetch', '', 'GET')
        var bodyPromise = null
        if (input && typeof input === 'object' && typeof input.url === 'string') {
          info.url = input.url
          info.method = String(input.method || 'GET')
          info.reqHeaders = stripAuth(headerList(input.headers))
          try {
            var clone = input.clone()
            bodyPromise = clone.body ? readCapped(clone.body, LIMIT) : null
          } catch (e) { bodyPromise = null }
        } else {
          info.url = resolveUrl(input)
          info.method = String((init && init.method) || 'GET')
          info.reqHeaders = stripAuth(headerList(init && init.headers))
          if (init && init.body != null) {
            info.reqBody = typeof init.body === 'string' ? truncate(init.body) : '[binary]'
          }
        }
        beg = { info: info, bodyPromise: bodyPromise }
      } catch (e) { beg = null }

      var p = origFetch.apply(this, arguments)
      if (!beg) return p
      return p.then(function (resp) {
        try {
          var respP = Promise.resolve('')
          try {
            var rc = resp.clone()
            respP = rc.body ? readCapped(rc.body, LIMIT) : Promise.resolve('')
          } catch (e) { respP = Promise.resolve('') }
          var reqP = beg.bodyPromise || Promise.resolve(null)
          var info = beg.info
          Promise.all([respP, reqP]).then(function (arr) {
            if (beg.bodyPromise) info.reqBody = truncate(arr[1])
            info.respBody = summarizeBody(arr[0])
            try { info.respHeaders = stripAuth(headerList(resp.headers)) } catch (e) {}
            info.status = typeof resp.status === 'number' ? resp.status : 0
            info.t = now()
            emit(info)
          }).catch(function () { info.t = now(); emit(info) })
        } catch (e) { /* 采样失败不影响页面 */ }
        return resp
      }, function (err) {
        try { beg.info.t = now(); emit(beg.info) } catch (e) {}
        throw err
      })
    }
  }

  // —— XHR 钩子（构造器透明替换：实例仍是原 XHR 类型，instanceof 不破）——
  var OrigXHR = window.XMLHttpRequest
  if (typeof OrigXHR === 'function') {
    var WrappedXHR = function () {
      var xhr = new OrigXHR()
      var info = blank('xhr', '', 'GET')
      var origOpen = xhr.open
      var origSend = xhr.send
      var origSetHeader = xhr.setRequestHeader
      xhr.open = function (method, url) {
        try { info.method = String(method || 'GET'); info.url = resolveUrl(url) } catch (e) {}
        return origOpen.apply(xhr, arguments)
      }
      if (typeof origSetHeader === 'function') {
        xhr.setRequestHeader = function (name, value) {
          try { if (!AUTH_SET[String(name).toLowerCase()]) info.reqHeaders[String(name).toLowerCase()] = String(value) } catch (e) {}
          return origSetHeader.apply(xhr, arguments)
        }
      }
      xhr.send = function (body) {
        try {
          if (body == null) info.reqBody = null
          else if (typeof body === 'string') info.reqBody = truncate(body)
          else info.reqBody = '[binary]'
        } catch (e) {}
        try {
          xhr.addEventListener('load', function () {
            try {
              info.status = typeof xhr.status === 'number' ? xhr.status : 0
              info.respHeaders = stripAuth(parseRawHeaders(xhr.getAllResponseHeaders()))
              var rt = xhr.responseType
              var text = null
              if (rt === '' || rt === 'text') text = xhr.responseText
              else if (rt === 'json') { try { text = JSON.stringify(xhr.response) } catch (e) { text = '[binary]' } }
              else text = '[binary]'
              info.respBody = summarizeBody(text)
            } catch (e) {}
            info.t = now()
            emit(info)
          })
          xhr.addEventListener('error', function () { info.t = now(); emit(info) })
          xhr.addEventListener('abort', function () { info.t = now(); emit(info) })
        } catch (e) {}
        return origSend.apply(xhr, arguments)
      }
      return xhr
    }
    WrappedXHR.prototype = OrigXHR.prototype // 保持 instanceof 语义
    window.XMLHttpRequest = WrappedXHR
  }
})();`
}
