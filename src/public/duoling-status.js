// 哆灵 · 页面脚本状态浮窗。
// 由 SW 经 chrome.userScripts.register 持久注册到独立世界 us-builtin-status（声明式注入，
// 不再每导航 execute）；脚本自己连一条端口回 SW 拿数据、发动作。
//
// ⚠️ 数据形状与 src/shared/extension-ipc.ts 的 StatusBubbleData / StatusBubblePush /
// StatusBubbleUp 手写对齐，改形状必须两边同步。
//
// 本文件是**有状态**的一方（「当前运行指针」归浮窗，不归 SW）：
//   · runs = { uuid: { runId: true } }  —— 本文档收到的脚本运行标识（脚本注入即广播，经 SW 转发）；
//   · 过滤口径：register 阶段错误恒显；runtime 错误只认「runId 命中 runs[uuid]」的那些。
//   · 为什么这样就够：浮窗是 per-document 实例（每个文档新建），runs 只装本文档的广播 →
//     真刷新 = 新实例 + 脚本重新 mint runId → 旧运行错误天然不再命中（角标自动清零）。
//   · SW 不做这个过滤（它不持有指针），故推下来的 errors 是全量，由本文件筛。
//
// 定位：只做「引导」——本页在跑哪些脚本、本次运行有没有报错、点击跳工作台错误日志。
// 没有启停、没有详情、没有修复动作（管控归工作台）；无命中脚本时浮窗自隐藏（data 为 null）。
;
(function () {
  'use strict'
  if (window.__duolingStatusMounted) return // 幂等：Chrome 重复注入只当一次

  var PORT_NAME = 'duoling:status'
  // SW 空闲被回收会断开端口；重连本身会唤醒 SW。延迟递增（封顶 15s）：
  // 既让「刚加载页面盯着验证」这个核心场景保持实时，又避免无限高频敲醒 SW。
  var RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 15000]
  var attempt = 0
  var port = null

  var state = { data: null, expanded: false, runs: {} }
  var root = null
  var shadow = null

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  /** 该脚本在「本次运行」里的错误（register 恒显；runtime 需 runId 命中） */
  function mineErrors(s) {
    var list = s.errors || []
    var set = state.runs[s.uuid] || {}
    var out = []
    for (var i = 0; i < list.length; i++) {
      var e = list[i]
      if (e.phase === 'register') out.push(e)
      else if (e.phase === 'runtime' && e.runId && set[e.runId]) out.push(e)
    }
    return out
  }

  function totalErrors() {
    var d = state.data
    if (!d) return 0
    var n = 0
    for (var i = 0; i < d.scripts.length; i++) n += mineErrors(d.scripts[i]).length
    return n
  }

  function render() {
    if (!shadow) return
    var d = state.data
    if (!d || !d.scripts || !d.scripts.length) {
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
        var mine = mineErrors(s)
        html += '<button class="row' + (mine.length ? ' has-err' : '') + '" data-uuid="' + esc(s.uuid) + '">' +
          '<span class="nm">' + esc(s.name) + '</span>' +
          (mine.length
            ? '<span class="ebadge" title="最新：' + esc(mine[0].message) + '">⚠ ' + esc(mine.length) + '</span>'
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
        // 上行跳转：端口另端（SW）收到后打开 / 聚焦工作台深链
        if (port) {
          try { port.postMessage({ t: 'openErrors', uuid: uuid }) } catch (err) { /* 端口已断：静默 */ }
        }
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
    var attach = function () {
      if (root.parentNode) return
      var host = document.documentElement || document.body
      if (host) host.appendChild(root)
    }
    if (!document.documentElement && !document.body) {
      // document_start 极早期兜底：等解析出 <html> 再挂（浮窗不参与页面布局，晚一帧无感）
      document.addEventListener('DOMContentLoaded', attach)
      document.addEventListener('readystatechange', attach)
      return
    }
    attach()
  }

  /** 端口消息：data = 全量数据（本文件负责过滤）；runstart = 记录本次运行标识 */
  function onMessage(raw) {
    var msg = raw
    if (!msg) return
    if (msg.t === 'data') {
      state.data = msg.data
      if (!msg.data) state.expanded = false
      render()
      return
    }
    if (msg.t === 'runstart' && msg.uuid && msg.runId) {
      var set = state.runs[msg.uuid] || (state.runs[msg.uuid] = {})
      if (!set[msg.runId]) {
        set[msg.runId] = true
        render()
      }
    }
  }

  function scheduleReconnect() {
    var delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)]
    attempt++
    window.setTimeout(connect, delay)
  }

  function connect() {
    try {
      // messaging 由 SW 在注册世界时开启（configureWorld）；未开时本调用会抛，退避重试
      port = chrome.runtime.connect({ name: PORT_NAME })
      port.onMessage.addListener(onMessage)
      port.onDisconnect.addListener(function () {
        port = null
        scheduleReconnect()
      })
      // 连上即拉一次：补上「断连期间少收的推送」（首帧由 SW 在连接时主动推，这里是二道保险）
      try { port.postMessage({ t: 'refresh' }) } catch (err) { /* 刚断：交给 onDisconnect */ }
    } catch (e) {
      port = null
      scheduleReconnect()
    }
  }

  window.__duolingStatusMounted = true
  mount()
  render()
  connect()
})()
