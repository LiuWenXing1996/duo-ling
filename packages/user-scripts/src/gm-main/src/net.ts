// gm-main 注入源 · 网络段（页面世界真源码）。
// 二进制 / FormData 请求体编码（base64 信封）、DOM 小工具（addStyle / addElement /
// 锚点下载 / 原始响应头 / 回调适配）与 GM_xmlhttpRequest 全套（responseType、
// abort、进度登记、超时与错误分帧）。
// 跨段引用的 declare const 约定见 channel.ts 文件头。
declare const __gmLog: (...args: any[]) => void
declare const __gmConnId: string
declare const __gmSend: (req: any) => Promise<any>
declare const __gmSendAfterChannel: (req: any) => Promise<any>
declare const __gmRegisterXhrProgress: (requestId: string, fn: any) => void
declare const __gmUnregisterXhrProgress: (requestId: string) => void

// —— 二进制 / FormData 请求体编码（GM_xmlhttpRequest 的 data）——
function __gmBase64ToArrayBuffer(b64: string) {
  var bin = atob(b64)
  var buf = new Uint8Array(bin.length)
  for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf.buffer
}
function __gmBytesToBase64(bytes: Uint8Array): string {
  var s = ''
  var chunk = 0x8000
  for (var i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as any)
  }
  return btoa(s)
}
function __gmCopyInit(s: any) {
  var c: any = {}
  for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k) && s[k] !== undefined) c[k] = s[k]
  return c
}
function __gmCopyHeaders(h: any) {
  var c: any = {}
  for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) c[k] = h[k]
  return c
}
/** 把 data（string/Blob/FormData/ArrayBuffer/TypedArray/DataView）编码成可跨桥的 init */
function __gmEncodeBody(raw: any): Promise<any> {
  if (raw == null) return Promise.resolve(null)
  // 字符串体也必须由包装器挂到 body 上：__gmXhr 的 init 字面量里没有 body 字段，
  // 不在这里交出去，文本体会在过桥前无声丢掉（契约侧 FetchInit.body 本就接受 string）
  if (typeof raw === 'string')
    return Promise.resolve(function (s: any) {
      var c = __gmCopyInit(s)
      c.body = raw
      return c
    })
  if (typeof Blob !== 'undefined' && raw instanceof Blob) {
    return raw.arrayBuffer().then(function (buf) {
      var env = { __dlBinaryBody: true, base64: __gmBytesToBase64(new Uint8Array(buf)) }
      return function (s: any) {
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
    var fields: any[] = []
    var pending: Promise<any>[] = []
    raw.forEach(function (value: any, name: any) {
      if (typeof value === 'string') {
        fields.push({ name: name, value: value })
      } else {
        pending.push(
          value.arrayBuffer().then(function (buf: any) {
            var f = typeof File !== 'undefined' && value instanceof File ? value.name : undefined
            fields.push({
              name: name,
              base64: __gmBytesToBase64(new Uint8Array(buf)),
              type: value.type || 'application/octet-stream',
              filename: f,
            })
          }),
        )
      }
    })
    return Promise.all(pending).then(function () {
      return function (s: any) {
        var c = __gmCopyInit(s)
        c.body = { __dlFormData: true, fields: fields }
        return c
      }
    })
  }
  if (typeof raw === 'object') {
    var bytes: Uint8Array
    if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw)
    else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(raw))
      bytes = new Uint8Array((raw as any).buffer, (raw as any).byteOffset, (raw as any).byteLength)
    else
      return Promise.reject(
        new Error(
          'GM_xmlhttpRequest：data 仅支持 string / Blob / FormData / ArrayBuffer / TypedArray / DataView',
        ),
      )
    var env2 = { __dlBinaryBody: true, base64: __gmBytesToBase64(bytes) }
    return Promise.resolve(function (s: any) {
      var c = __gmCopyInit(s)
      c.body = env2
      return c
    })
  }
  return Promise.reject(
    new Error(
      'GM_xmlhttpRequest：data 仅支持 string / Blob / FormData / ArrayBuffer / TypedArray / DataView',
    ),
  )
}

function __gmAddStyle(css: string) {
  var el = document.createElement('style')
  el.textContent = css
  ;(document.head || document.documentElement).appendChild(el)
  return el
}
function __gmAddElement(a: any, b?: any, c?: any) {
  var parent: any, tag: any, attrs: any
  if (typeof a === 'string') {
    parent = document.head || document.documentElement
    tag = a
    attrs = b
  } else {
    parent = a
    tag = b
    attrs = c
  }
  var el = document.createElement(tag)
  if (attrs) {
    for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue
      try {
        el.setAttribute(k, attrs[k])
      } catch (e) {}
    }
  }
  if (parent && parent.appendChild) parent.appendChild(el)
  return el
}
function __gmTriggerAnchor(href: string, name?: string) {
  var a = document.createElement('a')
  a.href = href
  a.download = name || 'download'
  ;(document.body || document.documentElement).appendChild(a)
  a.click()
  a.remove()
}
function __gmRawHeaders(obj: any): string {
  var out = ''
  for (var k in obj)
    if (Object.prototype.hasOwnProperty.call(obj, k)) out += k + ': ' + obj[k] + '\r\n'
  return out
}
function __gmWithCb(p: any, cb: any) {
  if (typeof cb !== 'function') return
  p.then(
    function (v: any) {
      try {
        cb(v)
      } catch (e) {}
    },
    function (e: any) {
      try {
        cb(undefined, (e && e.message) || String(e))
      } catch (_) {}
    },
  )
}
function __gmWithErrCb(p: any, cb: any) {
  if (typeof cb !== 'function') return
  p.then(
    function () {
      try {
        cb(null)
      } catch (e) {}
    },
    function (e: any) {
      try {
        cb((e && e.message) || String(e))
      } catch (_) {}
    },
  )
}

/** GM_xmlhttpRequest：回调式（TM 形状）+ 返回可 abort 的句柄 */
function __gmXhr(details: any) {
  var d = details || {}
  var requestId = (function () {
    try {
      return crypto.randomUUID()
    } catch (e) {
      return 'x-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    }
  })()
  var rt = d.responseType
  var responseType = rt === 'json' || rt === 'arraybuffer' || rt === 'blob' ? rt : 'text'
  if (rt === 'document' || rt === 'stream') {
    __gmLog('GM_xmlhttpRequest：responseType「' + rt + '」不受支持，已按 text 处理')
    responseType = 'text'
  }
  var aborted = false
  function base(status: any, statusText: any, headers: any, url: any): any {
    return {
      readyState: 4,
      status: status,
      statusText: statusText,
      responseHeaders: __gmRawHeaders(headers || {}),
      finalUrl: url || d.url,
      context: d.context,
    }
  }
  function toResponse(p: any) {
    var r = base(p.status, p.statusText, p.headers, p.url)
    var text = p.body || ''
    r.responseText = responseType === 'text' || responseType === 'json' ? text : ''
    if (responseType === 'arraybuffer') r.response = __gmBase64ToArrayBuffer(text)
    else if (responseType === 'blob')
      r.response = new Blob([__gmBase64ToArrayBuffer(text)], {
        type: (p.headers && p.headers['content-type']) || '',
      })
    else if (responseType === 'json') {
      try {
        r.response = JSON.parse(text)
      } catch (e) {
        r.response = null
      }
    } else r.response = text
    return r
  }
  var handle = {
    abort: function () {
      if (aborted) return
      aborted = true
      __gmSend({ c: 'fetch.abort', requestId: requestId }).catch(function () {})
      if (d.onabort) {
        try {
          d.onabort(base(0, '', {}, d.url))
        } catch (e) {}
      }
    },
  }
  if (d.onloadstart) {
    try {
      d.onloadstart(base(0, '', {}, d.url))
    } catch (e) {}
  }
  var chain = __gmEncodeBody(d.data).then(function (encode: any) {
    var wantsProgress = typeof d.onprogress === 'function'
    if (wantsProgress) __gmRegisterXhrProgress(requestId, d.onprogress)
    var init = {
      method: d.method,
      headers: d.headers,
      responseType: responseType === 'text' || responseType === 'json' ? 'text' : 'arraybuffer',
      timeout: d.timeout,
      redirect: d.redirect,
      requestId: requestId,
      wantProgress: wantsProgress,
      connId: __gmConnId,
    }
    // 要进度 → 先等通道（帧靠 Port 推）；不要 → 走普通请求-应答，不建通道
    var sendReq = wantsProgress ? __gmSendAfterChannel : __gmSend
    return sendReq({ c: 'fetch', url: d.url, init: encode ? encode(init) : init })
  })
  // 登记与请求同生命周期（成功 / 失败 / 中止都清）
  var __gmProgressDone = function () {
    __gmUnregisterXhrProgress(requestId)
  }
  chain.then(__gmProgressDone, __gmProgressDone)
  chain.then(
    function (p: any) {
      if (aborted) return
      var resp = toResponse(p)
      if (d.onreadystatechange) {
        try {
          d.onreadystatechange(resp)
        } catch (e) {}
      }
      if (d.onload) {
        try {
          d.onload(resp)
        } catch (e) {}
      }
    },
    function (e: any) {
      if (aborted) return
      var code = e && e.code
      var r = base(0, '', {}, d.url)
      if (code === 'BRIDGE_TIMEOUT') {
        if (d.ontimeout) {
          try {
            d.ontimeout(r)
          } catch (_) {}
        }
        return
      }
      if (d.onerror) {
        var errResp = base(0, '', {}, d.url)
        errResp.error = (e && e.message) || '请求失败'
        try {
          d.onerror(errResp)
        } catch (_) {}
      }
    },
  )
  return handle
}
