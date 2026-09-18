// 运行期报错：验证错误链路（us:errors，phase=runtime）与页面状态浮窗。
// 效果：先写标记 WILL_THROW，随后故意抛错 —— 脚本列表「错误日志」应出现一条运行期错误，
// 页面右下角浮窗应把该脚本标为出错（浮窗只认本次运行，刷新页面才会重新 mint runId）。
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
