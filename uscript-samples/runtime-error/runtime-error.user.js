// ==UserScript==
// @name         runtime-error
// @namespace    duoling
// @version      1.0.0
// @description  验证运行期错误链路（错误落盘 + 灵动岛监控）
// @match        *://*/*
// ==/UserScript==

// 运行期报错：验证错误链路与**归属口径**（同步走包装层 try/catch 直报；异步走 sourceURL 栈过滤）。
// 效果：先写标记 WILL_THROW，随后同步、异步各抛一条 —— 错误日志应出现**两条** phase=runtime
// 的运行期错误、对话界面灵动岛应把该脚本标为出错（都按 runId 归属到本次运行）。
// 页面自身的报错（栈里没有本脚本 sourceURL 标记）不应混进本脚本的日志 —— 可在有噪声的
// 页面（如被拦截器挡了监控 SDK 请求的站点）对照验证。
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
    throw new Error('哆灵测试：异步运行期错误（栈过滤归属）')
  }, 0)
  throw new Error('哆灵测试：同步运行期错误（正文 try/catch 归属）')
})()
