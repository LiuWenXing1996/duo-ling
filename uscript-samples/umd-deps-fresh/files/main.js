// UMD 依赖内联（冷拉验证用）：deps 的 jQuery URL 带时间戳参数（?v=…），
// 对浏览器 HTTP 缓存与 _deps/ 命名都是全新 URL —— 每次清/改参数后保存都是真网络拉取。
// 与 umd-deps 的区别仅此一处；页面标记前缀 umd-deps-fresh 便于区分两个用例。
;(function () {
  var ID = 'dl-test-umd-deps-fresh'

  function mark(text, bad) {
    var el = document.getElementById(ID)
    if (!el) {
      el = document.createElement('div')
      el.id = ID
      el.style.cssText =
        'position:fixed;right:12px;bottom:44px;z-index:2147483647;padding:6px 10px;' +
        'border-radius:6px;background:#111;color:#0f0;font:12px/1.4 ui-monospace,monospace'
      ;(document.body || document.documentElement).appendChild(el)
    }
    el.style.color = bad ? '#f55' : '#0f0'
    el.textContent = 'umd-deps-fresh: ' + text
  }

  try {
    if (typeof window.jQuery === 'function' && typeof window.$ === 'function') {
      mark('OK ' + window.jQuery.fn.jquery)
    } else {
      mark('jQuery 未就绪（依赖未拼接或页面 CSP 拦截）', true)
    }
  } catch (e) {
    mark('异常：' + ((e && e.message) || e), true)
  }
})()
