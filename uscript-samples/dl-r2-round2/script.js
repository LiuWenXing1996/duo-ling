// ==UserScript==
// @name         GM R2 五项手测
// @namespace    https://duoling.example
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_getTab
// @grant        GM_saveTab
// @grant        GM_getTabs
// @grant        GM_download
// ==/UserScript==
// GM 能力 API 二轮（R2）五项扩充 · 手测脚本
// 面板右上角浮动，每项一个按钮；钩子相关（fetch/tab/onUrlChange）载入即自动跑一轮，
// 需要手势/外网的单独点（clipboard/download 的弹下载框、httpbin 联网）。
//
// 五项覆盖：
//   ① GM_xmlhttpRequest 请求体 FormData/Blob + 响应 blob()
//   ② GM_setClipboard.write / text/html（offscreen 免手势 + 富文本）
//   ③ GM_saveTab/getTab/getTabs（标签页级存储）
//   ④ GM_download 本地 blob 直下（Blob/ArrayBuffer/TypedArray）
//   ⑤ window.onurlchange（SPA 路由感知）
//
// gmFetch：把 GM_xmlhttpRequest（回调式）包成返回 Response 形态（ok/status/json()/blob()/text()/headers）
// 的 Promise，便于直接在 await 链里用。标准油猴脚本常这么包一层。
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

  var ID = 'gm-r2-harness'
  function el(id, tag) { var e = document.getElementById(id); if (!e && tag) { e = document.createElement(tag); e.id = id } return e }

  // —— 面板 ——
  var panel = el(ID)
  if (!panel) {
    panel = document.createElement('div')
    panel.id = ID
    panel.style.cssText =
      'position:fixed;right:12px;top:12px;z-index:2147483647;width:340px;max-height:92vh;overflow:auto;' +
      'background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:8px;' +
      'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 8px 24px rgba(0,0,0,.4)'
    document.body.appendChild(panel)
  }
  panel.innerHTML =
    '<div style="padding:8px 10px;font-weight:700;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;align-items:center">' +
    '<span>GM R2 五项手测</span>' +
    '<span id="' + ID + '-clear" style="cursor:pointer;color:#8b949e;font-weight:400">清空</span></div>' +
    '<div id="' + ID + '-log" style="padding:6px 10px;white-space:pre-wrap"></div>' +
    '<div id="' + ID + '-btns" style="padding:0 10px 10px;display:grid;grid-template-columns:1fr 1fr;gap:6px"></div>'

  var logBox = el(ID + '-log')
  var btnBox = el(ID + '-btns')
  el(ID + '-clear').onclick = function () { logBox.textContent = '' }

  function log(kind, msg) {
    var color = { PASS: '#3fb950', FAIL: '#f85149', INFO: '#8b949e', RUN: '#d29922', URL: '#58a6ff' }[kind] || '#e6edf3'
    var line = document.createElement('div')
    line.style.cssText = 'margin:2px 0;border-left:3px solid ' + color + ';padding-left:6px'
    line.innerHTML = '<span style="color:' + color + '">[' + kind + ']</span> ' + String(msg).replace(/[<>&]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]
    })
    logBox.appendChild(line)
    logBox.scrollTop = logBox.scrollHeight
  }

  function btn(label, fn) {
    var b = document.createElement('button')
    b.textContent = label
    b.style.cssText = 'padding:6px 8px;background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;cursor:pointer;font:inherit'
    b.onmouseenter = function () { b.style.background = '#30363d' }
    b.onmouseleave = function () { b.style.background = '#21262d' }
    b.onclick = function () { b.disabled = true; Promise.resolve().then(fn).finally(function () { b.disabled = false }) }
    btnBox.appendChild(b)
    return b
  }

  // 统一包裹：记录 PASS/FAIL
  async function test(name, fn) {
    log('RUN', name + ' …')
    try {
      var detail = await fn()
      log('PASS', name + (detail ? ' — ' + detail : ''))
      return true
    } catch (e) {
      log('FAIL', name + ' — ' + ((e && e.message) || e))
      return false
    }
  }

  if (typeof GM_xmlhttpRequest !== 'function' || typeof GM_setClipboard !== 'function') {
    log('FAIL', 'GM 全局缺失：本脚本需注入到已装哆灵扩展、且 @grant 已声明对应能力')
    return
  }

  // ============ ① GM_xmlhttpRequest：FormData / Blob / blob() ============
  btn('① FormData', function () {
    return test('fetch FormData', async function () {
      var fd = new FormData()
      fd.set('field1', 'hello')
      fd.set('num', '42')
      fd.set('note', new File(['file-body-xyz'], 'note.txt', { type: 'text/plain' }))
      var r = await gmFetch('https://httpbin.org/post', { method: 'POST', body: fd, responseType: 'json' })
      if (!r.ok) throw new Error('httpbin 非 2xx: ' + r.status)
      var d = r.json()
      if (d.form.field1 !== 'hello' || d.form.num !== '42') throw new Error('文本字段未回显: ' + JSON.stringify(d.form))
      if (!d.files || d.files.note !== 'file-body-xyz') throw new Error('Blob 字段未回显: ' + JSON.stringify(d.files))
      return 'form=' + JSON.stringify(d.form) + ' file=' + d.files.note
    })
  })
  btn('① Blob体', function () {
    return test('fetch Blob 请求体', async function () {
      var r = await gmFetch('https://httpbin.org/post', {
        method: 'POST', body: new Blob(['rawblobdata'], { type: 'application/octet-stream' }), responseType: 'json',
      })
      if (!r.ok) throw new Error('非 2xx: ' + r.status)
      var d = r.json()
      if (d.data !== 'rawblobdata') throw new Error('raw body 未回显: ' + JSON.stringify(d.data))
      return 'data=' + d.data
    })
  })
  btn('① blob()', function () {
    return test('fetch blob()', async function () {
      var r = await gmFetch('https://httpbin.org/bytes/64', { responseType: 'arraybuffer' })
      if (!r.ok) throw new Error('非 2xx: ' + r.status)
      var blob = r.blob()
      if (!(blob instanceof Blob)) throw new Error('blob() 返回值不是 Blob')
      if (blob.size !== 64) throw new Error('size 错: ' + blob.size)
      return 'size=' + blob.size + ' type=' + blob.type
    })
  })
  btn('① blob()负例', function () {
    return test('blob() 非 arraybuffer 抛错', async function () {
      var r = await gmFetch('https://httpbin.org/get') // 默认 text 模式
      var threw = false
      try { r.blob() } catch (e) { threw = /responseType/i.test(e.message) }
      if (!threw) throw new Error('text 模式竟能调 blob()')
      return '已按预期抛错'
    })
  })

  // ============ ② GM_setClipboard ============
  btn('② write', function () {
    return test('clipboard.write', async function () {
      await GM.setClipboard('哆灵手测 ' + new Date().toLocaleTimeString())
      return '已写入，请 Ctrl+V 验证'
    })
  })
  btn('② writeHtml', function () {
    return test('clipboard.writeHtml', async function () {
      await GM.setClipboard('<b>富文本</b> <i>duo-ling</i>', { type: 'text/html' })
      return '已写入富文本，请在支持富文本的输入框粘贴验证'
    })
  })

  // ============ ③ GM.saveTab/getTab/getTabs ============
  btn('③ tab 往返', function () {
    return test('tab.save→get', async function () {
      var val = { v: 42, ts: Date.now() }
      await GM.saveTab(val)
      var back = await GM.getTab()
      if (!back || back.v !== 42) throw new Error('读回不一致: ' + JSON.stringify(back))
      return 'get=' + JSON.stringify(back)
    })
  })
  btn('③ tab.all', function () {
    return test('tab.all', async function () {
      await GM.saveTab({ marker: 'all-test' })
      var all = await GM.getTabs()
      if (!all || typeof all !== 'object') throw new Error('all() 非对象')
      var keys = Object.keys(all)
      return 'tab 数=' + keys.length + ' keys=' + keys.join(',')
    })
  })

  // ============ ④ GM_download 本地直下 ============
  btn('④ Blob下载', function () {
    return test('download(Blob)', async function () {
      await GM.download(new Blob(['hello duo-ling R2\n'], { type: 'text/plain' }), 'gm-r2-plain.txt')
      return '已触发下载 gm-r2-plain.txt'
    })
  })
  btn('④ TypedArray', function () {
    return test('download(Uint8Array)', async function () {
      await GM.download(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]), 'gm-r2-bytes.bin')
      return '已触发下载 gm-r2-bytes.bin（6 字节）'
    })
  })
  btn('④ 远程URL', function () {
    return test('download(URL)', async function () {
      await GM.download('https://httpbin.org/bytes/8', 'gm-r2-remote.bin')
      return '已触发远程下载 gm-r2-remote.bin'
    })
  })

  // ============ ⑤ window.onurlchange ============
  var urlSubscribed = false
  btn('⑤ 订阅', function () {
    return test('onUrlChange 订阅', async function () {
      if (urlSubscribed) return '已订阅'
      window.onurlchange = function (e) { log('URL', 'url.change → ' + (e && e.url)) }
      urlSubscribed = true
      return '订阅生效，点下方三个按钮触发路由变化'
    })
  })
  btn('⑤ pushState', function () {
    history.pushState(null, '', location.pathname + '?r2push=' + Date.now())
    log('INFO', '已 pushState，看上方 URL 行是否出现')
  })
  btn('⑤ replaceState', function () {
    history.replaceState(null, '', location.pathname + '?r2rep=' + Date.now())
    log('INFO', '已 replaceState，看上方 URL 行是否出现')
  })
  btn('⑤ hash', function () {
    location.hash = 'r2hash' + Date.now()
    log('INFO', '已改 hash，看上方 URL 行是否出现')
  })
  btn('⑤ 取消订阅', function () {
    if (urlSubscribed) { window.onurlchange = null; urlSubscribed = false; log('INFO', '已取消订阅') } else log('INFO', '本就未订阅')
  })

  // ============ 载入自动跑一轮（不依赖手势/不弹框的） ============
  log('INFO', 'GM ' + (GM_info ? GM_info.script.name : '?') + ' 已就绪，开始自动跑桥相关项')
  await test('fetch FormData (auto)', async function () {
    var fd = new FormData()
    fd.set('auto', 'ok')
    var r = await gmFetch('https://httpbin.org/post', { method: 'POST', body: fd, responseType: 'json' })
    if (!r.ok) throw new Error('非 2xx: ' + r.status)
    if (r.json().form.auto !== 'ok') throw new Error('未回显')
    return 'ok'
  })
  await test('tab 往返 (auto)', async function () {
    await GM.saveTab({ auto: true })
    var back = await GM.getTab()
    if (!back || back.auto !== true) throw new Error('读回不一致')
    return 'ok'
  })
  await test('onUrlChange 订阅 (auto)', async function () {
    if (!urlSubscribed) { window.onurlchange = function (e) { log('URL', 'url.change → ' + (e && e.url)) }; urlSubscribed = true }
    return 'ok（点 pushState/replaceState/hash 验证三种是否都触发）'
  })
  log('INFO', '自动轮结束。clipboard / download 需手动点按钮；⑤ 三种路由变化请逐个点验证触发情况。')
})()
