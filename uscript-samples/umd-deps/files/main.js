// UMD 依赖内联：deps 配 jQuery（project.json config.deps），保存/导入时经 offscreen 拉取
// 并按文本拼接进产物头部（断网可重构建，_deps/ 里有缓存源码）。
// 效果：页面标记显示 $ 探针结果 —— jQuery 拼接成功 = "OK $3.7.1"，失败 = 原因。
;(function () {
  var ID = 'dl-test-umd-deps'

  function mark(text, bad) {
    var el = document.getElementById(ID)
    if (!el) {
      el = document.createElement('div')
      el.id = ID
      el.style.cssText =
        'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:6px 10px;' +
        'border-radius:6px;background:#111;color:#0f0;font:12px/1.4 ui-monospace,monospace'
      ;(document.body || document.documentElement).appendChild(el)
    }
    el.style.color = bad ? '#f55' : '#0f0'
    el.textContent = 'umd-deps: ' + text
  }

  try {
    if (typeof window.jQuery === 'function' && typeof window.$ === 'function') {
      mark('OK ' + window.jQuery.fn.jquery)
      // 顺手证明真的能操作 DOM：探针元素本身用 jQuery 挂个一次性动画回调
      window.$(function () {
        window.$('#' + ID).on('click', function () {
          window.$(this).remove()
        })
      })
    } else {
      mark('jQuery 未就绪（依赖未拼接或页面 CSP 拦截）', true)
    }
  } catch (e) {
    mark('异常：' + ((e && e.message) || e), true)
  }
})()
