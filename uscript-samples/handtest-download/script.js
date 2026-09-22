// ==UserScript==
// @name         手测 · GM_download / 进度 / @resource
// @namespace    https://duoling.example
// @version      1.1.0
// @description  点按钮跑的手测面板（左下角）：saveAs 弹框 / 下载进度 / abort / @resource。每条按钮上都写着期望结果。控制台入口 __probe 也保留。
// @match        *://*/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_getResourceText
// @grant        GM_getResourceURL
// @resource     probeIcon https://www.tampermonkey.net/favicon.ico
// @noframes
// ==/UserScript==

;(function () {
  'use strict'

  // 够大的公开文件（看进度用）。哪个不通就点「换下载地址」
  var BIG = [
    'https://proof.ovh.net/files/10Mb.dat',
    'https://speed.cloudflare.com/__down?bytes=10000000',
    'https://ash-speed.hetzner.com/10MB.bin',
  ]

  // —— 浮面板（shadow DOM：站点 CSS 影响不到）——
  var host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647'
  var root = host.attachShadow({ mode: 'open' })
  root.innerHTML = [
    '<style>',
    '.p{width:304px;background:#fff;color:#111;border:1px solid #d0d7de;border-radius:10px;',
    'box-shadow:0 6px 24px rgba(0,0,0,.18);overflow:hidden;font:13px/1.5 system-ui,-apple-system,sans-serif}',
    '.h{display:flex;align-items:center;padding:8px 10px;background:#0a7;color:#fff;cursor:pointer;font-weight:600}',
    '.h .x{margin-left:auto;font-weight:400;opacity:.9}',
    '.b{padding:10px;display:grid;gap:6px}',
    'button{border:1px solid #0a7;background:#f2fbf8;color:#065f46;border-radius:6px;padding:6px 8px;',
    'cursor:pointer;text-align:left;font:inherit}',
    'button:hover{background:#dff5ec}',
    'button small{display:block;color:#6b7280;font-weight:400;font-size:11px}',
    '.live{padding:6px 10px;background:#111;color:#4ade80;font:12px/1.4 ui-monospace,monospace;',
    'min-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.log{max-height:160px;overflow:auto;padding:6px 10px;border-top:1px solid #e5e7eb;',
    'font:11px/1.5 ui-monospace,monospace;color:#374151;white-space:pre-wrap}',
    '.log .e{color:#b91c1c}',
    '.log .s{color:#047857}',
    '.ico{width:32px;height:32px;border:2px solid #0a7;border-radius:6px;background:#fff}',
    '.hide .b,.hide .live,.hide .log{display:none}',
    '</style>',
    '<div class="p">',
    '  <div class="h" id="hdr">手测面板<span class="x" id="tg">收起</span></div>',
    '  <div class="b">',
    '    <button data-a="saveAs">① 另存为<small>期望：弹「另存为」对话框</small></button>',
    '    <button data-a="noSave">① 对照：不传 saveAs<small>期望：不弹，直接落盘</small></button>',
    '    <button data-a="progress">② 下载 onprogress<small>期望：上方帧数 &gt; 1</small></button>',
    '    <button data-a="abort">③ abort（0.5s 后中止）<small>期望：日志出现 USER_CANCELED</small></button>',
    '    <button data-a="resource">④ @resource 取内容<small>期望：下面出现图标 + 文本长度</small></button>',
    '    <button data-a="xhrProgress">⑤ 对照：xhr onprogress<small>期望：帧数 &gt; 1</small></button>',
    '    <button data-a="big">换下载地址<small id="cur"></small></button>',
    '  </div>',
    '  <div class="live" id="live">就绪</div>',
    '  <div class="log" id="log"></div>',
    '</div>',
  ].join('')

  var liveEl = root.getElementById('live')
  var logEl = root.getElementById('log')
  var curEl = root.getElementById('cur')
  var panel = root.querySelector('.p')

  function log(msg, cls) {
    console.log('%c[手测]', 'color:#0a7;font-weight:bold', msg)
    var line = document.createElement('div')
    if (cls) line.className = cls
    line.textContent = new Date().toLocaleTimeString() + '  ' + msg
    logEl.appendChild(line)
    logEl.scrollTop = logEl.scrollHeight
  }
  function setLive(t) { liveEl.textContent = t }
  function showBig() { curEl.textContent = '当前：' + BIG[0].replace(/^https?:\/\//, '').slice(0, 32) }

  var api = {
    // ① 另存为
    saveAs: function (url, name) {
      var target = url || BIG[0]
      log('① 发起（saveAs: true）')
      log('① 现在盯屏幕：有没有弹「另存为」？', 's')
      return GM_download({
        url: target,
        name: name || 'probe-saveas.bin',
        saveAs: true,
        onload: function () { log('① 完成回调触发', 's') },
        onerror: function (e) { log('① 失败 → ' + ((e && e.error) || '未知') + '（换个地址再试）', 'e') },
      })
    },

    // ① 对照
    noSave: function (url, name) {
      var target = url || BIG[0]
      log('① 发起（不传 saveAs）')
      return GM_download({
        url: target,
        name: name || 'probe-nosave.bin',
        onload: function () { log('① 完成（这次不该有对话框）', 's') },
        onerror: function (e) { log('① 失败 → ' + ((e && e.error) || '未知'), 'e') },
      })
    },

    // ② 下载进度（SW 轮询 search，500ms 一跳）
    progress: function (url, name) {
      var frames = 0
      var last = null
      setLive('② 发起中…')
      log('② 发起（10MB 左右，看帧数涨）')
      return GM_download({
        url: url || BIG[0],
        name: name || 'probe-progress.bin',
        onprogress: function (p) {
          frames++
          last = p
          setLive('② 帧 #' + frames + '  ' + p.loaded + '/' + p.total + '  (' + p.lengthComputable + ')')
        },
        onload: function () {
          setLive('② 完成')
          log('② 完成：共 ' + frames + ' 帧 ' + (frames > 1 ? '✓ 轮询在推' : '✗ 只有 1 帧，没在推'), frames > 1 ? 's' : 'e')
        },
        onerror: function (e) { log('② 失败 → ' + ((e && e.error) || '未知'), 'e') },
      })
    },

    // ③ abort
    abort: function (url, name) {
      setLive('③ 发起中…')
      log('③ 发起（0.5s 后调 abort）')
      var h = GM_download({
        url: url || BIG[0],
        name: name || 'probe-abort.bin',
        onload: function () { log('③ 意外完成 —— 文件太小，换个大的再试', 'e') },
        onerror: function (e) {
          var err = (e && e.error) || '未知'
          log('③ 中止结果 → ' + err + (err === 'USER_CANCELED' ? '  ✓' : ''), err === 'USER_CANCELED' ? 's' : 'e')
        },
      })
      setTimeout(function () { log('③ 0.5s 到，h.abort()'); h.abort() }, 500)
      return h
    },

    // ④ @resource
    resource: function () {
      var text = GM_getResourceText('probeIcon')
      var url = GM_getResourceURL('probeIcon')
      log('④ 文本：' + (typeof text === 'string' ? text.length + ' 字符（二进制解出乱码正常，长度对即可）' : String(text)))
      log('④ data URI：' + (typeof url === 'string' ? url.slice(0, 48) + '… 共 ' + url.length + ' 字符' : String(url)))
      if (typeof url === 'string' && url) {
        var img = document.createElement('img')
        img.className = 'ico'
        img.src = url
        img.title = 'GM_getResourceURL 的 data URI'
        root.querySelector('.b').appendChild(img)
        log('④ 图标已插到上面 —— 显示出来即取到内容 ✓', 's')
      } else {
        log('④ 没取到资源', 'e')
      }
      return { text: text, url: url }
    },

    // ⑤ 对照：xhr 的 onprogress
    xhrProgress: function (url) {
      var frames = 0
      setLive('⑤ 发起中…')
      log('⑤ 发起（xhr 的 onprogress）')
      return GM_xmlhttpRequest({
        method: 'GET',
        url: url || BIG[0],
        onprogress: function (p) {
          frames++
          setLive('⑤ 帧 #' + frames + '  ' + p.loaded + '/' + p.total)
        },
        onload: function () {
          setLive('⑤ 完成')
          log('⑤ 完成：收到 ' + frames + ' 帧' + (frames > 1 ? '  ✓' : '  ✗ 太少（期望 >1）'), frames > 1 ? 's' : 'e')
        },
        onerror: function () { log('⑤ 失败（换地址）', 'e') },
      })
    },

    // 换下载地址
    big: function (i) {
      var idx = typeof i === 'number' && BIG[i] ? i : 1
      BIG.unshift(BIG.splice(idx % BIG.length, 1)[0])
      showBig()
      log('下载地址 → ' + BIG[0])
      return BIG[0]
    },
  }

  window.__probe = api // 控制台入口保留（不想点按钮时用）

  // 绑事件
  root.getElementById('hdr').addEventListener('click', function () {
    panel.classList.toggle('hide')
    root.getElementById('tg').textContent = panel.classList.contains('hide') ? '展开' : '收起'
  })
  root.querySelectorAll('button[data-a]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      try { api[btn.dataset.a]() } catch (e) { log(String((e && e.message) || e), 'e') }
    })
  })

  showBig()
  var mount = function () { document.body.appendChild(host) }
  document.body ? mount() : document.addEventListener('DOMContentLoaded', mount, { once: true })
})()
