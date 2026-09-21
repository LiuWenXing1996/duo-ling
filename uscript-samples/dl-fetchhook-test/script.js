// ==UserScript==
// @name         GM.page.fetchHook 探针
// @namespace    https://duoling.example
// @match        *://*/*
// @grant        GM_log
// ==/UserScript==
// GM.page.fetchHook 手测探针（被动观察「页面请求」的响应体）。
//
// 前提：fetchHook 拦的是**页面世界（MAIN）**的 fetch。用户脚本跑在独立隔离世界
//       （worldId: us-<uuid>），它自己的 window.fetch 与页面被代理的那个不是同一个绑定——
//       脚本自己发 fetch 永远测不到钩子。要触发，请求必须由**页面**发出：
//         ① 在真实站点上正常操作（站点 JS 自己会发请求）—— 本探针的主用法，也是权威验证；
//         ② 点角标「自测」：往页面注入一段 MAIN 世界脚本，由页面 GET 本页 + 打一个哨兵 URL。
//
// ⚠️ 自测通道的已知限制（2026-09-20 实测）：② 依赖「从脚本世界往页面 DOM 插入内联 <script>」，
//    在 example.com 与 rebang.today 上都没能触发（注入的脚本从未执行）。原因**未定论**，
//    但可排除「页面 CSP」这个说法：两站响应头与 HTML 都没有 CSP（curl 实测），且按 Chrome
//    文档，DOM 注入且立即执行的脚本**不受页面 CSP 限制**。最可能的是 USER_SCRIPT 世界自身的
//    默认 CSP 拦下了这枚内联脚本（本扩展刻意不放开世界 CSP）——**仅为假设，未验证**。
//    → 所以自测显示「?」不代表功能坏：**以 ① 的被动观察为准**。
//
// 用法：导入 → 启用 → 打开页面 → 角标进入「观察中」，实时列出被拦到的页面请求；
//       点角标跑一次自测（只刷新结果区，不会清掉已观察到的列表）。
// 被动观察对页面零侵入：裁决恒 passthrough，绝不改页面任何请求。
;(async () => {
  var ID = 'gm-test-fetchhook'
  var DOM_ATTR = 'data-gm-fetchhook-probe' // MAIN 世界脚本 → 隔离世界 的回传通道（DOM 跨世界共享）
  var SENTINEL_PATH = '/gm-hook-sentinel' // 命中这段的请求由桩伪造响应（不出网）
  var MAX_BODY = 1 << 20
  var MAX_SHOW = 5
  var results = [] // 自测结果 { name, ok, detail }，ok: true / false / null(未能判定)
  var observed = [] // 被动观察到的页面响应（滚动保留最近若干条）
  var lastMethod = {} // url -> method（补全出站方法）
  var pendingNodes = [] // 自测注入的 script 节点，待自测结束后统一清理
  var offHook = null
  var running = false

  function ensureBadge() {
    var el = document.getElementById(ID)
    if (!el) {
      el = document.createElement('div')
      el.id = ID
      el.style.cssText =
        'position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:8px 10px;' +
        'border-radius:6px;background:#111;color:#0f0;font:12px/1.5 ui-monospace,monospace;' +
        'cursor:pointer;max-width:560px;white-space:pre-wrap;box-shadow:0 2px 8px rgba(0,0,0,.4)'
      ;(document.body || document.documentElement).appendChild(el)
      el.addEventListener('click', function () {
        if (!running) runSelfTest()
      })
    }
    return el
  }

  function tag(ok) {
    return ok === true ? '✓ ' : ok === false ? '✗ ' : '? '
  }

  function render(head) {
    var el = ensureBadge()
    var lines = [head || 'GM.page.fetchHook 探针 · 观察中（点角标自测）']
    for (var i = 0; i < results.length; i++) {
      var r = results[i]
      lines.push(tag(r.ok) + r.name + (r.detail ? ' — ' + r.detail : ''))
    }
    lines.push('— 已观察 ' + observed.length + ' 条页面请求 —')
    if (!observed.length) {
      lines.push('（本页暂无页面请求：去真实站点操作，或点此自测）')
    } else {
      for (var j = Math.max(0, observed.length - MAX_SHOW); j < observed.length; j++) {
        var o = observed[j]
        lines.push(
          '· ' + o.method + ' ' + shortUrl(o.url) + ' → ' + o.status + ' · ' + o.len + 'B' +
            (o.truncated ? '（截断）' : ''),
        )
      }
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

  function shortUrl(u) {
    var x = String(u).replace(/^https?:\/\//, '')
    return x.length > 44 ? x.slice(0, 44) + '…' : x
  }

  function msg(e) {
    return (e && e.message) || String(e)
  }

  function waitFor(fn, ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now()
      var iv = setInterval(function () {
        var ok = false
        try { ok = fn() } catch (_) {}
        if (ok) { clearInterval(iv); resolve(true) }
        else if (Date.now() - t0 > ms) { clearInterval(iv); resolve(false) }
      }, 30)
    })
  }

  function observedOf(url) {
    for (var i = observed.length - 1; i >= 0; i--) if (observed[i].url === url) return observed[i]
    return null
  }

  // 往页面注入一段 MAIN 世界脚本发 fetch：只有页面世界的 fetch 才在桩的代理链上。
  // 结果经 DOM 属性回传（隔离世界读不到 MAIN 世界的 JS 变量，但能读共享 DOM）。
  //
  // 注意：**不立即摘掉 script 节点**。早期版本是 append 后马上 removeChild——若浏览器把内联脚本的
  // 执行排到下一个任务（而非插入时同步执行），节点已被摘掉、脚本就永不执行，症状会伪装成「功能坏」。
  // 这里保留节点，等自测跑完（或超时）再由 cleanupNodes() 统一清理，排除这一类假象。
  function injectPageFetch(url, probeTag) {
    var src =
      ';(function(){var out={tag:' + JSON.stringify(probeTag) + '};' +
      'function rep(){try{document.documentElement.setAttribute(' + JSON.stringify(DOM_ATTR) + ',JSON.stringify(out))}catch(e){}}' +
      'function fail(e){out.err=String((e&&e.message)||e);rep()}' +
      'try{fetch(' + JSON.stringify(url) + ',{cache:"no-store"}).then(function(r){' +
      'return r.text().then(function(t){out.status=r.status;out.len=t.length;out.head=t.slice(0,64);rep()})' +
      '},fail)}catch(e){fail(e)}})();'
    var s = document.createElement('script')
    s.textContent = src
    ;(document.head || document.documentElement).appendChild(s)
    pendingNodes.push(s)
  }

  function cleanupNodes() {
    for (var i = 0; i < pendingNodes.length; i++) {
      var n = pendingNodes[i]
      if (n.parentNode) n.parentNode.removeChild(n)
    }
    pendingNodes = []
  }

  function readProbe(probeTag) {
    try {
      var raw = document.documentElement.getAttribute(DOM_ATTR)
      if (!raw) return null
      var o = JSON.parse(raw)
      return o && o.tag === probeTag ? o : null
    } catch (e) { return null }
  }

  // 注册被动观察：裁决恒 passthrough（零侵入），响应体经 onResponse 拿到。
  async function install() {
    offHook = await GM.page.fetchHook(
      function (call) {
        lastMethod[call.url] = call.method
        if (call.url.indexOf(SENTINEL_PATH) >= 0) {
          return { action: 'respond', status: 200, headers: { 'content-type': 'text/plain' }, body: 'PAGE_GOT_FAKE' }
        }
        return { action: 'passthrough' }
      },
      {
        onResponse: function (resp) {
          observed.push({
            url: resp.url,
            method: lastMethod[resp.url] || '?',
            status: resp.status,
            len: resp.body ? resp.body.length : 0,
            truncated: !!resp.truncated,
          })
          if (observed.length > 40) observed.shift()
          if (!running) render() // 自测跑动中让位给结果区，避免刷屏
        },
      },
    )
  }

  async function runSelfTest() {
    running = true
    results = []
    // 只重置结果区，**不清 observed**——自测失败（? ）时已观察到的站点请求仍在，那才是权威证据
    render('自测中…（注入页面脚本，由页面发请求）')

    var home = location.href
    var sentinel = location.origin + SENTINEL_PATH

    // 用例 1：页面 GET 本页 → passthrough，应被动拿到响应体，且与页面实际收到的一致（未被消耗）
    document.documentElement.removeAttribute(DOM_ATTR)
    injectPageFetch(home, 'home')
    var sawProbe = await waitFor(function () { return !!readProbe('home') }, 3000)
    var sawObs = sawProbe ? await waitFor(function () { return !!observedOf(home) }, 2000) : false
    if (!sawProbe) {
      line(
        '页面请求被拦 + 被动读响应体',
        null,
        '注入的页面脚本没有执行（自测通道受限，与被动观察无关）——请改在真实站点上操作验证',
      )
    } else if (!sawObs) {
      line('页面请求被拦 + 被动读响应体', false, '页面已发出请求，但钩子没拦到（onResponse 未回调）')
    } else {
      var p = readProbe('home')
      var o = observedOf(home)
      var same = o.status === p.status && o.len === Math.min(p.len, MAX_BODY)
      line(
        '页面请求被拦 + 被动读响应体',
        same,
        '页面拿到 ' + p.status + '/' + p.len + 'B，观察侧 ' + o.status + '/' + o.len + 'B —— 全等=' + same,
      )
    }

    // 用例 2：页面打哨兵 → respond，页面拿伪造体，且 onResponse 不回调
    document.documentElement.removeAttribute(DOM_ATTR)
    injectPageFetch(sentinel, 'sentinel')
    var gotSentinel = await waitFor(function () { return !!readProbe('sentinel') }, 3000)
    if (!gotSentinel) {
      line('respond 伪造响应生效', null, '注入的页面脚本没有执行（自测通道受限，与被动观察无关）')
    } else {
      var sp = readProbe('sentinel')
      var gotFake = (sp.head || '') === 'PAGE_GOT_FAKE' && sp.len === 13
      line(
        'respond 伪造响应生效（onResponse 不回调）',
        gotFake && !observedOf(sentinel),
        '页面体=' + JSON.stringify(sp.head || '') + ' 哨兵被观察=' + !!observedOf(sentinel),
      )
    }

    cleanupNodes()
    var failed = results.filter(function (r) { return r.ok === false }).length
    var unknown = results.filter(function (r) { return r.ok === null }).length
    var tail = failed ? '完成：' + failed + ' 项失败' : '完成：全部通过 ✓'
    if (unknown) {
      tail += '；另有 ' + unknown + ' 项未能判定（自测通道受限，不影响上面的被动观察）'
    }
    running = false
    render(tail)
  }

  try {
    if (typeof GM === 'undefined' || !GM.page || typeof GM.page.fetchHook !== 'function') {
      render('GM_MISSING（本脚本世界没有 GM.page.fetchHook）')
      return
    }
    await install()
    render('GM.page.fetchHook 探针 · 观察中（点角标自测）')
    GM_log('[fetchHook 探针] 已注册被动观察：在真实站点上操作即可看到页面请求与响应体大小')
  } catch (e) {
    render('GM_FAIL ' + msg(e))
  }
})()
