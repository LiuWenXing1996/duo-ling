// DL API 收口探针：一期收口（fetch timeout / 二进制请求体 / tabs 三连）
// + 二期特权增强（forbidden header 覆写 / 同 host 隔离 / redirect manual·error）的手测脚本。
// 效果：页面右下角出现「DL API 收口探针」角标，点击后逐项跑测试并就地标 ✓ / ✗。
// 注意：网络用例走 httpbin.org（慢或挂时对应项会失败，属环境问题不是桥的锅）；
// tabs 用例会短暂开一个 example.com 标签页（约 2s 后自动关），全程点击触发、不自动跑。
// 二期用例的前提：扩展 manifest 带 declarativeNetRequestWithHostAccess + webRequest，
// 且 dev 是在加权限之后重启的——否则「覆写上线」与「manual 读 3xx」两项必失败。
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

  // ————— 二期：DNR header 覆写与 redirect 语义（2026-09-19 落地） —————
  // 覆写是否真的上线，只看 DL.fetch 的返回值证明不了——forbidden header 会被 fetch 静默
  // 丢弃，必须由服务端回显作证，故这几项一律拿 httpbin.org/headers 的回显断言。

  var REDIRECT_URL = 'https://httpbin.org/absolute-redirect/1'

  function lowerHeaders(h) {
    var out = {}
    for (var k in h) out[k.toLowerCase()] = h[k]
    return out
  }

  // ① 覆写真的上线：Cookie / Referer / User-Agent 三个禁设头应原样出现在服务端回显里
  function headerOverrideCase() {
    var want = {
      Cookie: 'dl_probe=1',
      Referer: 'https://dl-probe.example/ref',
      'User-Agent': 'DLProbe/1.0',
    }
    return DL.fetch('https://httpbin.org/headers', { headers: want }).then(
      function (r) {
        if (!r.ok) return line('forbidden header 覆写上线', false, 'HTTP ' + r.status)
        var got = lowerHeaders(r.json().headers)
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
  function isolationCase() {
    var t0 = Date.now()
    return Promise.all([
      DL.fetch('https://httpbin.org/delay/1', {
        headers: { Cookie: 'dl_probe=1', 'User-Agent': 'DLProbe/1.0' },
      }),
      DL.fetch('https://httpbin.org/headers?plain=1'),
    ]).then(
      function (rs) {
        var taken = Date.now() - t0
        var reader = rs[1]
        if (!reader.ok) return line('同 host 纯请求不被污染', false, '读者 HTTP ' + reader.status)
        var got = lowerHeaders(reader.json().headers)
        var dirty = []
        if (got.cookie) dirty.push('Cookie=' + got.cookie)
        if (got['user-agent'] === 'DLProbe/1.0') dirty.push('User-Agent 被覆写')
        line(
          '同 host 纯请求不被污染',
          dirty.length === 0,
          dirty.length ? '被套上：' + dirty.join(' / ') : '读者干净，排在写者之后（' + taken + 'ms）',
        )
      },
      function (e) {
        line('同 host 纯请求不被污染', false, msg(e))
      },
    )
  }

  // ③ redirect:'manual'：SW fetch 只拿得到 opaqueredirect，状态与 Location 靠观察型 webRequest 补齐
  function manualRedirectCase() {
    return DL.fetch(REDIRECT_URL, { redirect: 'manual' }).then(
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
    return DL.fetch(REDIRECT_URL, { redirect: 'error' }).then(
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
    render('运行中…（约 15s，期间会短暂开一个标签页）')
    await timeoutAbortCase()
    await timeoutZeroCase()
    await binaryBodyCase()
    await arrayBufferAndDataViewCase()
    await stringBodyCase()
    await invalidBodyCase()
    // 二期四项：header 覆写 / 同 host 隔离 / redirect manual·error
    await headerOverrideCase()
    await isolationCase()
    await manualRedirectCase()
    await errorRedirectCase()
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
