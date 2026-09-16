// 哆灵 · 页面脚本状态浮窗（提案② runtime-feedback-loop.md）。
// 由 SW 经 chrome.userScripts.execute() 注入到独立世界 us-builtin-status（仅注入文件本体，
// 数据经入口指令 __duolingStatus(data) 传入；实时更新经补注入 __duolingStatusUpdate(data)）。
//
// ⚠️ 数据形状与 src/shared/extension-ipc.ts 的 StatusBubbleData 手写对齐，改形状必须两边同步。
//
// 定位：只做「引导」——本页在跑哪些脚本、有没有报错、点击跳工作台错误日志。
// 没有启停、没有详情、没有修复动作（管控归工作台）；无命中脚本时浮窗自隐藏（null 数据）。
;
(function () {
  'use strict'
  if (window.__duolingStatus) return // 幂等：重复 execute 只换数据，不重建

  var state = { data: null, expanded: false }
  var root = null
  var shadow = null

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function totalErrors() {
    var d = state.data
    if (!d) return 0
    return d.scripts.reduce(function (n, s) { return n + (s.errorCount || 0) }, 0)
  }

  function render() {
    if (!shadow) return
    var d = state.data
    if (!d || !d.scripts.length) {
      root.style.display = 'none'
      return
    }
    root.style.display = ''
    var errTotal = totalErrors()
    var html = ''
    html += '<style>' + css() + '</style>'
    html += '<div class="dl-st" role="complementary" aria-label="哆灵脚本状态">'
    if (!state.expanded) {
      html +=
        '<button class="pill' + (errTotal ? ' has-err' : '') + '" data-act="toggle" title="本页脚本状态（哆灵）">' +
        '<span class="dot"></span><span class="txt">' + esc(d.scripts.length) + ' 脚本</span>' +
        (errTotal ? '<span class="badge">' + esc(errTotal) + '</span>' : '') +
        '</button>'
    } else {
      html += '<div class="panel">'
      html += '<div class="head"><span class="host">' + esc(d.host) + '</span>' +
        '<button class="x" data-act="toggle" title="收起">×</button></div>'
      html += '<div class="rows">'
      for (var i = 0; i < d.scripts.length; i++) {
        var s = d.scripts[i]
        html += '<button class="row' + (s.errorCount ? ' has-err' : '') + '" data-uuid="' + esc(s.uuid) + '">' +
          '<span class="nm">' + esc(s.name) + '</span>' +
          (s.errorCount
            ? '<span class="ebadge" title="最新：' + esc(s.lastError ? s.lastError.message : '') + '">⚠ ' + esc(s.errorCount) + '</span>'
            : '<span class="ok">运行中</span>') +
          '</button>'
      }
      html += '</div>'
      html += '<div class="foot">点击脚本 → 工作台错误日志</div>'
      html += '</div>'
    }
    html += '</div>'
    shadow.innerHTML = html
  }

  function onClick(e) {
    var t = e.target
    while (t && t !== shadow.host) {
      var act = t.getAttribute && t.getAttribute('data-act')
      if (act === 'toggle') {
        state.expanded = !state.expanded
        e.preventDefault()
        e.stopPropagation()
        render()
        return
      }
      var uuid = t.getAttribute && t.getAttribute('data-uuid')
      if (uuid) {
        e.preventDefault()
        e.stopPropagation()
        // 上行跳转：messaging 已对本世界开启；SW 收到后打开 / 聚焦工作台深链
        try {
          chrome.runtime.sendMessage({ __duolingStatusNav: true, uuid: uuid }, function () {
            void chrome.runtime.lastError // 尽力而为：无人应答也不在页面里报错
          })
        } catch (err) { /* 世界未开 messaging 等场景：静默 */ }
        state.expanded = false
        render()
        return
      }
      t = t.parentNode
    }
  }

  function css() {
    return [
      '.dl-st{position:fixed;right:14px;bottom:14px;z-index:2147483646;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2328;}',
      '.dl-st *{box-sizing:border-box;margin:0;padding:0;}',
      '.pill{display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.92);box-shadow:0 2px 8px rgba(0,0,0,.18);cursor:pointer;font:inherit;color:inherit;}',
      '.pill:hover{background:#fff;}',
      '.pill .dot{width:8px;height:8px;border-radius:50%;background:#22a06b;flex:none;}',
      '.pill.has-err .dot{background:#d93025;}',
      '.pill .badge{background:#d93025;color:#fff;border-radius:999px;padding:0 6px;font-size:10px;line-height:16px;flex:none;}',
      '.panel{width:240px;border-radius:10px;border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.97);box-shadow:0 4px 16px rgba(0,0,0,.22);overflow:hidden;}',
      '.head{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:rgba(0,0,0,.04);border-bottom:1px solid rgba(0,0,0,.08);}',
      '.head .host{font-weight:600;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.head .x{border:0;background:none;font:inherit;font-size:14px;cursor:pointer;color:#666;padding:0 2px;}',
      '.rows{max-height:220px;overflow:auto;}',
      '.row{display:flex;align-items:center;gap:6px;width:100%;padding:7px 10px;border:0;border-bottom:1px solid rgba(0,0,0,.06);background:none;font:inherit;color:inherit;cursor:pointer;text-align:left;}',
      '.row:hover{background:rgba(0,0,0,.04);}',
      '.row .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.row .ebadge{flex:none;color:#d93025;font-size:10px;font-weight:600;}',
      '.row .ok{flex:none;color:#22a06b;font-size:10px;}',
      '.foot{padding:5px 10px;font-size:10px;color:#888;background:rgba(0,0,0,.03);}',
    ].join('')
  }

  function mount() {
    root = document.createElement('div')
    root.setAttribute('data-duoling-status', '')
    root.style.display = 'none'
    shadow = root.attachShadow({ mode: 'closed' })
    shadow.addEventListener('click', onClick, true)
    ;(document.documentElement || document.body).appendChild(root)
  }

  /** 注入入口（随浮窗文件一起 execute）：创建（如未建）+ 更新数据 */
  window.__duolingStatus = function (data) {
    if (!root) mount()
    state.data = data
    state.expanded = false // 新导航 / 数据刷新回到收起态
    render()
  }

  /** 更新入口（SW 补注入）：null = 隐藏；浮窗不在场时 no-op */
  window.__duolingStatusUpdate = function (data) {
    if (!root) {
      if (!data) return
      mount()
    }
    state.data = data
    render()
  }
})()
