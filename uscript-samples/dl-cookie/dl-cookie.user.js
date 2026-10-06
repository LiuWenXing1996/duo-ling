// ==UserScript==
// @name         GM.cookie 探针
// @namespace    https://duoling.example
// @match        https://example.com/*
// @grant        GM_cookie
// @grant        GM_log
// ==/UserScript==
// GM.cookie 手测探针（list / set / delete + 域名门）。
// 用法：导入本包 → 启用 → 打开 https://example.com（**匹配规则刻意只写 example.com**，
// 探针的越域用例要依赖「脚本作用域之外」才有意义；换站前先改 @match）。
// 效果：页面右下角出现角标，点击后逐项跑用例并就地标 ✓ / ✗。
// 用例全程自清理（写入的 cookie 末尾删掉），跑完页面 cookie 不留痕。
;(async () => {
  var ID = 'gm-test-cookie'
  var COOKIE = 'gm_cookie_probe'
  var results = [] // { name, ok, detail }
  var running = false

  function ensureBadge() {
    var el = document.getElementById(ID)
    if (!el) {
      el = document.createElement('div')
      el.id = ID
      el.style.cssText =
        'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:6px 10px;' +
        'border-radius:6px;background:#111;color:#0f0;font:12px/1.5 ui-monospace,monospace;' +
        'cursor:pointer;max-width:460px;white-space:pre-wrap'
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

  function msg(e) {
    return (e && e.message) || String(e)
  }

  function code(e) {
    return (e && e.code) || ''
  }

  /** 跨桥拿到的 cookie 必须是数组（恒数组契约：空数组 = 没有） */
  function isArray(v) {
    return Array.isArray(v)
  }

  // ① set → list 往返：url 缺省（包装层填 location.href）+ document.cookie 交叉验证
  async function roundTripCase() {
    try {
      await GM_cookie.set({ name: COOKIE, value: 'v1', secure: true })
      var all = await GM_cookie.list()
      if (!isArray(all)) {
        line('set → list 往返（url 缺省当前页）', false, 'list() 没返回数组：' + JSON.stringify(all))
        return
      }
      var one = all.filter(function (c) { return c.name === COOKIE })[0]
      if (!one) {
        line('set → list 往返（url 缺省当前页）', false, '写的 cookie 读不回来')
        return
      }
      // 独立证人：非 HttpOnly 的 cookie 应当同时出现在页面 document.cookie 里
      var seenByPage = ('; ' + document.cookie).indexOf('; ' + COOKIE + '=v1') >= 0
      var shapeOk = one.session === true && one.hostOnly === true && one.path === '/'
      line(
        'set → list 往返（url 缺省当前页）',
        one.value === 'v1' && seenByPage && shapeOk,
        'value=' + one.value + ' 页面可见=' + seenByPage + ' session/hostOnly/path=' + one.session + '/' + one.hostOnly + '/' + one.path,
      )
    } catch (e) {
      line('set → list 往返（url 缺省当前页）', false, code(e) + ' ' + msg(e))
    }
  }

  // ② 按 name 查单条：命中是单元素数组，未命中是空数组（**不是 null**）
  async function byNameCase() {
    try {
      var hit = await GM_cookie.list({ name: COOKIE })
      var miss = await GM_cookie.list({ name: COOKIE + '_nope' })
      var ok = isArray(hit) && hit.length === 1 && isArray(miss) && miss.length === 0
      line('按 name 查：命中 [c] / 未命中 []', ok, 'hit=' + hit.length + ' miss=' + miss.length)
    } catch (e) {
      line('按 name 查：命中 [c] / 未命中 []', false, code(e) + ' ' + msg(e))
    }
  }

  // ③ 作用域是 host 级：matches 写的是 https://example.com/*，换条路径不该被门拦
  async function pathAgnosticCase() {
    try {
      var r = await GM_cookie.list({ url: location.origin + '/some/deep/path?q=1' })
      line('path 不参与域名门（同 host 换路径）', isArray(r), '返回 ' + (r.length) + ' 条')
    } catch (e) {
      line('path 不参与域名门（同 host 换路径）', false, code(e) + ' ' + msg(e))
    }
  }

  // ④ 越域必须被门拦下（脚本 matches 只写了 example.com）
  async function outOfScopeCase() {
    try {
      await GM_cookie.list({ url: 'https://out-of-scope.test/' })
      line('越域拒绝', false, '域外 url 竟然放行了')
    } catch (e) {
      line('越域拒绝', code(e) === 'PERMISSION_DENIED', code(e) + ' ' + msg(e))
    }
  }

  // ⑤ 非 http(s) 的 url 是参数问题（INVALID_ARG），与越域区分开
  async function badUrlCase() {
    try {
      await GM_cookie.list({ url: 'about:blank' })
      line('非 http(s) url 拒绝', false, 'about:blank 竟然放行了')
    } catch (e) {
      line('非 http(s) url 拒绝', code(e) === 'INVALID_ARG', code(e) + ' ' + msg(e))
    }
  }

  // ⑥ delete 后读不到（同一 name 写两条路径无关，这里只验「删了就没了」）
  async function removeCase() {
    try {
      await GM_cookie.delete({ name: COOKIE })
      var after = await GM_cookie.list({ name: COOKIE })
      var gone = isArray(after) && after.length === 0
      var pageGone = ('; ' + document.cookie).indexOf('; ' + COOKIE + '=') < 0
      line('delete 后读不到', gone && pageGone, 'GM 读 ' + after.length + ' 条 / 页面可见=' + !pageGone)
    } catch (e) {
      line('delete 后读不到', false, code(e) + ' ' + msg(e))
    }
  }

  async function runSuite() {
    running = true
    results = []
    render('运行中…')
    await roundTripCase()
    await byNameCase()
    await pathAgnosticCase()
    await outOfScopeCase()
    await badUrlCase()
    await removeCase()
    var failed = results.filter(function (r) { return !r.ok }).length
    render(failed ? '完成：' + failed + ' 项失败' : '完成：全部通过 ✓')
    running = false
  }

  try {
    if (typeof GM_cookie !== 'object') {
      render('GM_MISSING（本脚本世界没有 GM_cookie）')
      return
    }
    render('GM.cookie 探针 · 点击运行（需在 https://example.com 上）')
    GM_log('探针就绪，点击角标开始')
  } catch (e) {
    render('GM_FAIL ' + msg(e))
  }
})()
