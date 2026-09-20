// DL 能力 API 二轮（R2）五项扩充 · 手测脚本
// 面板右上角浮动，每项一个按钮；钩子相关（fetch/tab/onUrlChange）载入即自动跑一轮，
// 需要手势/外网的单独点（clipboard/download 的弹下载框、httpbin 联网）。
//
// 五项覆盖：
//   ① DL.fetch 请求体 FormData/Blob + 响应 blob()
//   ② DL.clipboard.write / writeHtml（offscreen 免手势 + 富文本）
//   ③ DL.tab.get/save/all（标签页级存储）
//   ④ DL.download 本地 blob 直下（Blob/ArrayBuffer/TypedArray）
//   ⑤ DL.onUrlChange（SPA 路由感知）
;(async () => {
  var ID = 'dl-r2-harness'
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
    '<span>DL R2 五项手测</span>' +
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

  if (!window.DL) { log('FAIL', 'window.DL 缺失：本脚本需注入到已装哆灵扩展的页面'); return }

  // ============ ① fetch：FormData / Blob / blob() ============
  btn('① FormData', function () {
    return test('fetch FormData', async function () {
      var fd = new FormData()
      fd.set('field1', 'hello')
      fd.set('num', '42')
      fd.set('note', new File(['file-body-xyz'], 'note.txt', { type: 'text/plain' }))
      var r = await DL.fetch('https://httpbin.org/post', { method: 'POST', body: fd, responseType: 'json' })
      if (!r.ok) throw new Error('httpbin 非 2xx: ' + r.status)
      var d = r.json()
      if (d.form.field1 !== 'hello' || d.form.num !== '42') throw new Error('文本字段未回显: ' + JSON.stringify(d.form))
      if (!d.files || d.files.note !== 'file-body-xyz') throw new Error('Blob 字段未回显: ' + JSON.stringify(d.files))
      return 'form=' + JSON.stringify(d.form) + ' file=' + d.files.note
    })
  })
  btn('① Blob体', function () {
    return test('fetch Blob 请求体', async function () {
      var r = await DL.fetch('https://httpbin.org/post', {
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
      var r = await DL.fetch('https://httpbin.org/bytes/64', { responseType: 'arraybuffer' })
      if (!r.ok) throw new Error('非 2xx: ' + r.status)
      var blob = r.blob()
      if (!(blob instanceof Blob)) throw new Error('blob() 返回值不是 Blob')
      if (blob.size !== 64) throw new Error('size 错: ' + blob.size)
      return 'size=' + blob.size + ' type=' + blob.type
    })
  })
  btn('① blob()负例', function () {
    return test('blob() 非 arraybuffer 抛错', async function () {
      var r = await DL.fetch('https://httpbin.org/get') // 默认 text 模式
      var threw = false
      try { r.blob() } catch (e) { threw = /responseType/i.test(e.message) }
      if (!threw) throw new Error('text 模式竟能调 blob()')
      return '已按预期抛错'
    })
  })

  // ============ ② clipboard ============
  btn('② write', function () {
    return test('clipboard.write', async function () {
      await DL.clipboard.write('哆灵手测 ' + new Date().toLocaleTimeString())
      return '已写入，请 Ctrl+V 验证'
    })
  })
  btn('② writeHtml', function () {
    return test('clipboard.writeHtml', async function () {
      await DL.clipboard.writeHtml('<b>富文本</b> <i>duo-ling</i>', '富文本回退文本')
      return '已写入富文本，请在支持富文本的输入框粘贴验证'
    })
  })

  // ============ ③ DL.tab ============
  btn('③ tab 往返', function () {
    return test('tab.save→get', async function () {
      var val = { v: 42, ts: Date.now() }
      await DL.tab.save(val)
      var back = await DL.tab.get()
      if (!back || back.v !== 42) throw new Error('读回不一致: ' + JSON.stringify(back))
      return 'get=' + JSON.stringify(back)
    })
  })
  btn('③ tab.all', function () {
    return test('tab.all', async function () {
      await DL.tab.save({ marker: 'all-test' })
      var all = await DL.tab.all()
      if (!all || typeof all !== 'object') throw new Error('all() 非对象')
      var keys = Object.keys(all)
      return 'tab 数=' + keys.length + ' keys=' + keys.join(',')
    })
  })

  // ============ ④ download 本地直下 ============
  btn('④ Blob下载', function () {
    return test('download(Blob)', async function () {
      await DL.download(new Blob(['hello duo-ling R2\n'], { type: 'text/plain' }), 'dl-r2-plain.txt')
      return '已触发下载 dl-r2-plain.txt'
    })
  })
  btn('④ TypedArray', function () {
    return test('download(Uint8Array)', async function () {
      await DL.download(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]), 'dl-r2-bytes.bin')
      return '已触发下载 dl-r2-bytes.bin（6 字节）'
    })
  })
  btn('④ 远程URL', function () {
    return test('download(URL)', async function () {
      await DL.download('https://httpbin.org/bytes/8', 'dl-r2-remote.bin')
      return '已触发远程下载 dl-r2-remote.bin'
    })
  })

  // ============ ⑤ onUrlChange ============
  var urlOff = null
  btn('⑤ 订阅', function () {
    return test('onUrlChange 订阅', async function () {
      if (urlOff) return '已订阅'
      urlOff = await DL.onUrlChange(function (url) { log('URL', 'url.change → ' + url) })
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
    if (urlOff) { urlOff(); urlOff = null; log('INFO', '已取消订阅') } else log('INFO', '本就未订阅')
  })

  // ============ 载入自动跑一轮（不依赖手势/不弹框的） ============
  log('INFO', 'DL ' + (DL.info ? DL.info.name : '?') + ' 已就绪，开始自动跑桥相关项')
  await test('fetch FormData (auto)', async function () {
    var fd = new FormData()
    fd.set('auto', 'ok')
    var r = await DL.fetch('https://httpbin.org/post', { method: 'POST', body: fd, responseType: 'json' })
    if (!r.ok) throw new Error('非 2xx: ' + r.status)
    if (r.json().form.auto !== 'ok') throw new Error('未回显')
    return 'ok'
  })
  await test('tab 往返 (auto)', async function () {
    await DL.tab.save({ auto: true })
    var back = await DL.tab.get()
    if (!back || back.auto !== true) throw new Error('读回不一致')
    return 'ok'
  })
  await test('onUrlChange 订阅 (auto)', async function () {
    if (!urlOff) urlOff = await DL.onUrlChange(function (url) { log('URL', 'url.change → ' + url) })
    return 'ok（点 pushState/replaceState/hash 验证三种是否都触发）'
  })
  log('INFO', '自动轮结束。clipboard / download 需手动点按钮；⑤ 三种路由变化请逐个点验证触发情况。')
})()
