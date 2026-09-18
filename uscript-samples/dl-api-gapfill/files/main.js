// DL API 一期收口探针：fetch timeout / 二进制请求体 / tabs 三连的手测脚本。
// 效果：页面右下角出现「DL API 收口探针」角标，点击后逐项跑测试并就地标 ✓ / ✗。
// 注意：网络用例走 httpbin.org（慢或挂时对应项会失败，属环境问题不是桥的锅）；
// tabs 用例会短暂开一个 example.com 标签页（约 2s 后自动关），全程点击触发、不自动跑。
;(async () => {
  var ID = 'dl-test-api-gapfill'
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
      lines.push((r.ok ? '✓ ' : '✗ ') + r.name + (r.detail ? ' — ' + r.detail : ''))
    }
    el.textContent = lines.join('\n')
    el.style.color = results.some(function (r) { return !r.ok }) ? '#f66' : '#0f0'
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
    return DL.fetch('https://httpbin.org/delay/5', { timeout: 2000 }).then(
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
    return DL.fetch('https://httpbin.org/get?probe=timeout0', { timeout: 0 }).then(
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
    return DL.fetch('https://httpbin.org/post', {
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
      DL.fetch('https://httpbin.org/post', { method: 'POST', body: buf }),
      DL.fetch('https://httpbin.org/post', { method: 'POST', body: view }),
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
    return DL.fetch('https://httpbin.org/post', { method: 'POST', body: 'probe=ok' }).then(
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
    return DL.fetch('https://httpbin.org/post', { method: 'POST', body: {} }).then(
      function () {
        line('非法体拒绝', false, '传了 {} 竟然没抛错')
      },
      function (e) {
        line('非法体拒绝', true, (e && e.code ? e.code + ' ' : '') + msg(e))
      },
    )
  }

  function tabsCase() {
    return (async function () {
      var id = await DL.tabs.open('https://example.com/#dl-api-probe', { active: false })
      if (typeof id !== 'number') {
        line('tabs open/focus/close', false, 'open 未返回数字 tabId：' + JSON.stringify(id))
        return
      }
      await sleep(1200)
      await DL.tabs.focus(id) // 应把 example.com 那个后台标签页拉到前台
      await sleep(800)
      await DL.tabs.close(id)
      var badRejected = false
      try {
        await DL.tabs.close(-1)
      } catch (e) {
        badRejected = true
      }
      line('tabs open/focus/close', badRejected, 'tabId=' + id + (badRejected ? '' : '；close(-1) 未拒绝'))
    })().catch(function (e) {
      line('tabs open/focus/close', false, msg(e))
    })
  }

  async function runSuite() {
    running = true
    results = []
    render('运行中…（约 10s，期间会短暂开一个标签页）')
    await timeoutAbortCase()
    await timeoutZeroCase()
    await binaryBodyCase()
    await arrayBufferAndDataViewCase()
    await stringBodyCase()
    await invalidBodyCase()
    await tabsCase()
    var failed = results.filter(function (r) { return !r.ok }).length
    render(failed ? '完成：' + failed + ' 项失败' : '完成：全部通过 ✓')
    running = false
  }

  try {
    if (!window.DL || !window.DL.fetch || !window.DL.tabs) {
      render('DL_MISSING（缺 DL.fetch / DL.tabs）')
      return
    }
    render('DL API 收口探针 · 点击运行')
    DL.log('探针就绪，点击角标开始')
  } catch (e) {
    render('DL_FAIL ' + msg(e))
  }
})()
