// ==UserScript==
// @name         dom-probe
// @namespace    duoling
// @version      1.0.0
// @description  验证脚本确实被注入并执行：页面右下角写标记
// @match        *://*/*
// @grant        GM_log
// ==/UserScript==

// 注入探针：验证「脚本确实被注入并执行了」。
// 效果：页面右下角出现一块标记，文本 = 主机名 + 注入时刻。
// 断言方式：`document.getElementById('dl-test-dom-probe').textContent` 以 INJECTED 开头。
;(function () {
  var ID = 'dl-test-dom-probe'
  var el = document.getElementById(ID)
  if (!el) {
    el = document.createElement('div')
    el.id = ID
    el.style.cssText =
      'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:6px 10px;' +
      'border-radius:6px;background:#111;color:#0f0;font:12px/1.4 ui-monospace,monospace'
    ;(document.body || document.documentElement).appendChild(el)
  }
  el.textContent = 'INJECTED ' + location.host + ' @' + new Date().toLocaleTimeString('zh-CN')
  if (typeof GM_log === 'function') GM_log('注入探针已生效：', location.href)
})()
