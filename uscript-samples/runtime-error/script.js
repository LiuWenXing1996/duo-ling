// ==UserScript==
// @name         runtime-error
// @namespace    duoling
// @version      1.0.0
// @description  验证运行期错误链路（错误落盘 + 灵动岛监控）
// @match        *://*/*
// ==/UserScript==

// 运行期报错：验证错误链路（错误日志落盘，phase=runtime）与侧边栏灵动岛监控。
// 效果：先写标记 WILL_THROW，随后故意抛错 —— 脚本列表「错误日志」应出现一条运行期错误，
// 侧边栏灵动岛应把该脚本标为出错（错误按 runId 归属到本次运行，刷新页面会重新 mint runId）。
;(function () {
  var ID = 'dl-test-runtime-error'
  var el = document.getElementById(ID)
  if (!el) {
    el = document.createElement('div')
    el.id = ID
    el.style.cssText =
      'position:fixed;right:12px;bottom:120px;z-index:2147483647;padding:6px 10px;' +
      'border-radius:6px;background:#111;color:#f55;font:12px/1.4 ui-monospace,monospace'
    ;(document.body || document.documentElement).appendChild(el)
  }
  el.textContent = 'WILL_THROW'
  setTimeout(function () {
    throw new Error('哆灵测试：故意的运行期错误')
  }, 0)
})()
