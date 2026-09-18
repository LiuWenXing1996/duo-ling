// 多文件构建：验证导入 / 保存时的 esbuild 打包（相对导入 + 子目录模块）。
// 效果：页面标记显示「你好，多文件构建 @<时:分:秒>」，文本由另两个模块拼出。
import { greet } from './utils.js'
import { fmtTime } from './lib/format.js'

;(function () {
  var ID = 'dl-test-multi-file'
  var el = document.getElementById(ID)
  if (!el) {
    el = document.createElement('div')
    el.id = ID
    el.style.cssText =
      'position:fixed;right:12px;bottom:84px;z-index:2147483647;padding:6px 10px;' +
      'border-radius:6px;background:#111;color:#0f0;font:12px/1.4 ui-monospace,monospace'
    ;(document.body || document.documentElement).appendChild(el)
  }
  el.textContent = greet('多文件构建') + ' @' + fmtTime(new Date())
})()
