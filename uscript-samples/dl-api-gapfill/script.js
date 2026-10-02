// ==UserScript==
// @name         GM API 收口探针
// @namespace    https://duoling.example
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_log
// ==/UserScript==
// GM API 收口探针：覆盖 fetch timeout / 二进制请求体 / tabs，以及特权增强项
// （forbidden header 覆写 / 同 host 隔离 / redirect manual·error）的手测脚本。
// 效果：页面右下角出现「GM API 收口探针」角标，点击后逐项跑测试并就地标三态：
//   ✓ 通过 / ✗ 功能失败 / ? 未能判定（httpbin 抖动、拿不到回显，重跑即可——别当成桥的锅）。
// tabs 用例会短暂开一个 example.com 标签页（约 2s 后自动关），全程点击触发、不自动跑；
// 网络用例都走 httpbin.org。
//
// gmFetch：把 GM_xmlhttpRequest（回调式）包成返回 Response 形态（ok/status/json()/blob()/text()/headers）
// 的 Promise，便于直接在 .then 链里用。标准油猴脚本常这么包一层。
;(async () => {
  function parseHeaders(s) {
    var out = {}
    String(s || '').split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf(':')
      if (i < 0) return
      var k = line.slice(0, i).trim().toLowerCase()
      var v = line.slice(i + 1).trim()
      if (k) out[k] = v
    })
    return out
  }

  function gmFetch(url, opts) {
    opts = opts || {}
    var rt = opts.responseType || 'text'
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        url: url,
        method: opts.method || 'GET',
        headers: opts.headers,
        data: opts.body,
        responseType: rt,
        timeout: opts.timeout,
        redirect: opts.redirect,
        onload: function (r) {
          var body = rt === 'json'
            ? (r.response == null ? r.responseText : r.response)
            : rt === 'arraybuffer' || rt === 'blob'
              ? r.response
              : (typeof r.response === 'string' ? r.response : r.responseText)
          resolve({
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            statusText: r.statusText || '',
            headers: parseHeaders(r.responseHeaders),
            data: typeof body === 'string' ? body : undefined,
            json: function () {
              if (body == null) throw new Error('空响应，无法 json()')
              if (typeof body !== 'string') return body
              return JSON.parse(body)
            },
            text: function () { return typeof body === 'string' ? body : (body == null ? '' : String(body)) },
            blob: function () {
              if (body instanceof Blob) return body
              if (body instanceof ArrayBuffer) return new Blob([body])
              if (typeof body === 'string' && (rt === 'arraybuffer' || rt === 'blob')) return new Blob([body])
              throw new Error('responseType 非 arraybuffer/blob，无法取 blob（需先设 responseType）')
            },
          })
        },
        onerror: function (r) { reject(new Error((r && r.error) || '请求失败')) },
        ontimeout: function () { var e = new Error('GM_xmlhttpRequest 请求超时'); e.code = 'BRIDGE_TIMEOUT'; reject(e) },
        onabort: function () { var e = new Error('请求已中止'); e.code = 'ABORTED'; reject(e) },
      })
    })
  }

  var ID = 'gm-test-api-gapfill'
  var results = [] // { name, ok, detail }
  var running = false

  function ensureBadge() {
    var el = document.getElementById(ID)
    if (!el) {
      el = document.createElement('div')
      el.id = ID
      el.style.cssText =
        'position:fixed;right:12px;bottom:48px;z-index:2147483647;padding:6px 10px;' +
        'border-radius:6px;background:#111;color:#0f0;font:12px/1.5 ui-monospace,monospace;' +
        'cursor:pointer;max-width:420px;white-space:pre-wrap'
      ;(document.body || document.documentElement).appendChild(el)
      el.addEventListener('click', function () {
        if (!running) runSuite()
      })
    }
    return el
  }

  function render(head) {
    var el = ensureBadge()
    var lines = head ? [head] : []
    for (var i = 0; i < results.length; i++) {
      var r = results[i]
      // 三态：true 通过 / false 功能失败 / null 未判定（环境问题，拿不到可断言的数据）
      var tag = r.ok === true ? '✓ ' : r.ok === false ? '✗ ' : '? '
      lines.push(tag + r.name + (r.detail ? ' — ' + r.detail : ''))
    }
    el.textContent = lines.join('\n')
    var hasFail = results.some(function (r) { return r.ok === false })
    var hasUnknown = results.some(function (r) { return r.ok === null })
    el.style.color = hasFail ? '#f66' : hasUnknown ? '#fc0' : '#0f0'
  }

  function line(name, ok, detail) {
    results.push({ name: name, ok: ok, detail: detail || '' })
    render()
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms) })
  }

  function msg(e) {
    return (e && e.message) || String(e)
  }

  function timeoutAbortCase() {
    var t0 = Date.now()
    return gmFetch('https://httpbin.org/delay/5', { timeout: 2000 }).then(
      function () {
        line('timeout 到点中止', false, '请求没被中止（httpbin 返回太快，换慢接口重试）')
      },
      function (e) {
        var took = Date.now() - t0
        var m = msg(e)
        var ok = took < 4500 && /超时|BRIDGE_TIMEOUT|TIMEOUT/i.test(m)
        line('timeout 到点中止', ok, took + 'ms — ' + m)
      },
    )
  }

  function timeoutZeroCase() {
    return gmFetch('https://httpbin.org/get?probe=timeout0', { timeout: 0 }).then(
      function (r) {
        line('timeout=0 不限', r.ok, 'status ' + r.status)
      },
      function (e) {
        line('timeout=0 不限', false, msg(e))
      },
    )
  }

  // 字节 [1,2,3,'A','B']：ASCII 段内（含控制字符），UTF-8 往返无损，httpbin /post 的 data 字段可精确比对
  function binaryBodyCase() {
    return gmFetch('https://httpbin.org/post', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3, 65, 66]),
    }).then(
      function (r) {
        var data = r.ok ? r.json().data : null
        line('二进制请求体（TypedArray）', data === '\u0001\u0002\u0003AB', JSON.stringify(data))
      },
      function (e) {
        line('二进制请求体（TypedArray）', false, msg(e))
      },
    )
  }

  function arrayBufferAndDataViewCase() {
    var buf = new ArrayBuffer(3)
    var dv = new DataView(buf)
    dv.setUint8(0, 65)
    dv.setUint8(1, 66)
    dv.setUint8(2, 67)
    var view = new Uint8Array(buf, 1, 2) // 视图：只应发出 'BC'，不是整个 buffer
    return Promise.all([
      gmFetch('https://httpbin.org/post', { method: 'POST', body: buf }),
      gmFetch('https://httpbin.org/post', { method: 'POST', body: view }),
    ]).then(
      function (rs) {
        var whole = rs[0].ok ? rs[0].json().data : null
        var part = rs[1].ok ? rs[1].json().data : null
        var ok = whole === 'ABC' && part === 'BC'
        line('ArrayBuffer / 视图体', ok, 'whole=' + JSON.stringify(whole) + ' part=' + JSON.stringify(part))
      },
      function (e) {
        line('ArrayBuffer / 视图体', false, msg(e))
      },
    )
  }

  function stringBodyCase() {
    return gmFetch('https://httpbin.org/post', { method: 'POST', body: 'probe=ok' }).then(
      function (r) {
        var data = r.ok ? r.json().data : null
        line('字符串体透传', data === 'probe=ok', JSON.stringify(data))
      },
      function (e) {
        line('字符串体透传', false, msg(e))
      },
    )
  }

  function invalidBodyCase() {
    return gmFetch('https://httpbin.org/post', { method: 'POST', body: {} }).then(
      function () {
        line('非法体拒绝', false, '传了 {} 竟然没抛错')
      },
      function (e) {
        line('非法体拒绝', true, (e && e.code ? e.code + ' ' : '') + msg(e))
      },
    )
  }

  // ————— DNR header 覆写与 redirect 语义 —————
  // 覆写是否真的上线，只看 gmFetch 的返回值证明不了——forbidden header 会被 fetch 静默
  // 丢弃，必须由服务端回显作证，故这几项一律拿 httpbin.org/headers 的回显断言。

  var REDIRECT_URL = 'https://httpbin.org/absolute-redirect/1'

  function lowerHeaders(h) {
    var out = {}
    for (var k in h) out[k.toLowerCase()] = h[k]
    return out
  }

  // httpbin /headers 的正常回显必然带这几个真实请求头之一；一个都没有，说明拿到的不是正常回显
  // （CDN 兜底页、半截响应、空体等）。此时「回显里没有脏头」证明不了「没被污染」——只能记未判定。
  // 这条判据堵的是「空回显也能判 ✓」的恒真洞：没有数据，就不许下「干净」的结论。
  var ECHO_MARKERS = ['host', 'accept', 'user-agent', 'accept-encoding', 'connection']

  function readEcho(r) {
    try {
      var h = r.json().headers
      if (!h) return null
      var low = lowerHeaders(h)
      for (var i = 0; i < ECHO_MARKERS.length; i++) {
        if (low[ECHO_MARKERS[i]]) return low
      }
      return null
    } catch (e) {
      return null
    }
  }

  // ① 覆写真的上线：Cookie / Referer / User-Agent 三个禁设头应原样出现在服务端回显里
  function headerOverrideCase() {
    var want = {
      Cookie: 'gm_probe=1',
      Referer: 'https://gm-probe.example/ref',
      'User-Agent': 'GMProbe/1.0',
    }
    return gmFetch('https://httpbin.org/headers', { headers: want }).then(
      function (r) {
        // 非 2xx / 回显不可辨认 = 没拿到可断言的证据，记未判定——不许当成「覆写没生效」
        if (!r.ok) {
          return line('forbidden header 覆写上线', null, 'HTTP ' + r.status + '（httpbin 抖动）——未能判定')
        }
        var got = readEcho(r)
        if (!got) return line('forbidden header 覆写上线', null, '回显不可辨认——未能判定（重跑即可）')
        var bad = []
        for (var k in want) {
          if (got[k.toLowerCase()] !== want[k]) {
            bad.push(k + '=' + JSON.stringify(got[k.toLowerCase()]))
          }
        }
        line(
          'forbidden header 覆写上线',
          bad.length === 0,
          bad.length ? '回显不符：' + bad.join(' / ') : 'Cookie/Referer/UA 回显一致',
        )
      },
      function (e) {
        line('forbidden header 覆写上线', false, msg(e))
      },
    )
  }

  // ② 同 host 隔离：写者（带覆写）挂规则期间，并发发出的纯请求绝不能沾上覆写头。
  // 写者用 /delay/1 拉长规则挂起窗口，读者若被并发放行就会落在窗口内——能真正区分锁有无效。
  // 读者非 2xx 或回显不可辨认（httpbin 抖动，502 常见）时重试一次；两次都拿不到回显只能记
  // 「未判定」——502 的响应体是空的，读不出 header 干不干净，判功能失败会把人往错方向带。
  function isolationCase() {
    var t0 = Date.now()
    var writerFailed = false
    var writer = gmFetch('https://httpbin.org/delay/1', {
      headers: { Cookie: 'gm_probe=1', 'User-Agent': 'GMProbe/1.0' },
    }).then(
      function () {},
      function () {
        writerFailed = true
      },
    )
    // 读者要的是「一份可辨认的回显」：非 2xx、或 2xx 但回显里没有任何已知真实头（空体 / 兜底页），
    // 都无从判断 header 干不干净 → 隔 500ms 重试一次；两次都拿不到才记「未能判定」。
    var readPlain = function (n) {
      return gmFetch('https://httpbin.org/headers?plain=' + n).then(
        function (r) {
          return { status: r.status, echo: r.ok ? readEcho(r) : null }
        },
        function (e) {
          return { status: msg(e), echo: null }
        },
      )
    }
    var reader = readPlain(1).then(function (a) {
      if (a.echo) return a
      return sleep(500).then(function () {
        return readPlain(2)
      })
    })
    return Promise.all([writer, reader]).then(
      function (rs) {
        var taken = Date.now() - t0
        var a = rs[1]
        if (!a.echo) {
          return line(
            '同 host 纯请求不被污染',
            null,
            '读者两次都没拿到可辨认的回显（' + a.status + '）——未能判定，非锁的问题',
          )
        }
        var got = a.echo
        var dirty = []
        if (got.cookie) dirty.push('Cookie=' + got.cookie)
        if (got['user-agent'] === 'GMProbe/1.0') dirty.push('User-Agent 被覆写')
        line(
          '同 host 纯请求不被污染',
          dirty.length === 0,
          dirty.length
            ? '被套上：' + dirty.join(' / ')
            : '读者干净，排在写者之后（' + taken + 'ms' + (writerFailed ? '，写者自身抖动' : '') + '）',
        )
      },
      function (e) {
        line('同 host 纯请求不被污染', false, msg(e))
      },
    )
  }

  // ③ redirect:'manual'：SW fetch 只拿得到 opaqueredirect，状态与 Location 靠观察型 webRequest 补齐
  function manualRedirectCase() {
    return gmFetch(REDIRECT_URL, { redirect: 'manual' }).then(
      function (r) {
        var loc = (r.headers && (r.headers.location || r.headers.Location)) || ''
        var ok = r.status === 302 && !!loc
        line('redirect:manual 读 3xx', ok, 'status=' + r.status + ' location=' + JSON.stringify(loc))
      },
      function (e) {
        line('redirect:manual 读 3xx', false, msg(e))
      },
    )
  }

  // ④ redirect:'error'：交 fetch 原生语义（遇 3xx 直接拒绝），与 manual 走的是两条路
  function errorRedirectCase() {
    return gmFetch(REDIRECT_URL, { redirect: 'error' }).then(
      function (r) {
        line('redirect:error 拒绝', false, '没抛错，status=' + r.status)
      },
      function (e) {
        line('redirect:error 拒绝', true, (e && e.code ? e.code + ' ' : '') + msg(e))
      },
    )
  }

  function tabsCase() {
    return (async function () {
      // GM_openInTab 返回句柄 { close, closed }；tabId 异步到达、句柄不暴露，故用句柄 close 收尾。
      var handle = GM_openInTab('https://example.com/#gm-api-probe', { active: false })
      if (!handle || typeof handle.close !== 'function') {
        line('tabs open/close', false, 'GM_openInTab 未返回句柄：' + JSON.stringify(handle))
        return
      }
      await sleep(1200)
      handle.close()
      await sleep(400)
      line('tabs open/close', true, 'GM_openInTab 句柄已 open 并 close')
    })().catch(function (e) {
      line('tabs open/close', false, msg(e))
    })
  }

  async function runSuite() {
    running = true
    results = []
    render('运行中…（约 15s，期间会短暂开一个标签页）')
    await timeoutAbortCase()
    await timeoutZeroCase()
    await binaryBodyCase()
    await arrayBufferAndDataViewCase()
    await stringBodyCase()
    await invalidBodyCase()
    // 特权增强四项：header 覆写 / 同 host 隔离 / redirect manual·error
    await headerOverrideCase()
    await isolationCase()
    await manualRedirectCase()
    await errorRedirectCase()
    await tabsCase()
    var failed = results.filter(function (r) { return r.ok === false }).length
    var unknown = results.filter(function (r) { return r.ok === null }).length
    var tail = failed ? '完成：' + failed + ' 项失败' : '完成：全部通过 ✓'
    if (unknown) tail += '；另有 ' + unknown + ' 项未判定（环境抖动，需重跑）'
    render(tail)
    running = false
  }

  try {
    if (typeof GM_xmlhttpRequest !== 'function' || typeof GM_openInTab !== 'function') {
      render('GM_MISSING（缺 GM_xmlhttpRequest / GM_openInTab）')
      return
    }
    render('GM API 收口探针 · 点击运行')
    GM_log('探针就绪，点击角标开始')
  } catch (e) {
    render('GM_FAIL ' + msg(e))
  }
})()
