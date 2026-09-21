// ==UserScript==
// @name         GM 桥往返
// @namespace    https://duoling.example
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_log
// ==/UserScript==
// GM 桥往返：脚本世界 ⇄ background SW 的桥是否通。
// 效果：页面标记显示 GM_OK / GM_MISSING / GM_FAIL:<原因>。
// 走一遍 GM_setValue → GM_getValue → GM_listValues，外加 GM_info 自省与 GM_log。
;(async () => {
  var ID = 'gm-test-bridge'

  function mark(text) {
    var el = document.getElementById(ID)
    if (!el) {
      el = document.createElement('div')
      el.id = ID
      el.style.cssText =
        'position:fixed;right:12px;bottom:48px;z-index:2147483647;padding:6px 10px;' +
        'border-radius:6px;background:#111;color:#0f0;font:12px/1.4 ui-monospace,monospace'
      ;(document.body || document.documentElement).appendChild(el)
    }
    el.textContent = text
  }

  try {
    if (typeof GM_setValue !== 'function') return mark('GM_MISSING（本脚本世界没有 GM_setValue）')
    GM_log('脚本信息', GM_info.script.name)

    GM_setValue('probe', { at: Date.now(), host: location.host })
    var back = GM_getValue('probe')
    var keys = GM_listValues()
    if (keys.indexOf('probe') < 0) return mark('GM_BAD_KEYS ' + keys.join(','))
    if (!back || back.host !== location.host) return mark('GM_BAD_VALUE ' + JSON.stringify(back))

    GM_deleteValue('probe')
    mark('GM_OK ' + JSON.stringify(back))
  } catch (e) {
    mark('GM_FAIL ' + ((e && e.message) || e))
  }
})()
