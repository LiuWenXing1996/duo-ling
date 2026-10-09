// ==UserScript==
// @name         运行日志样例
// @namespace    duoling
// @version      1.0.1
// @description  每次运行都产生可看的记录：运行行（带页面地址）、两条运行期错误，外加两条「无法归属」的错误行
// @match        *://*/*
// @grant        GM_download
// @noframes
// @require      http://127.0.0.1:1/nope.js
// ==/UserScript==

// 运行日志样例：一次页面加载就把面板上的几种行都造出来（不需要额外操作）。
//
// 面板上会看到：
//   · 一条运行行，带「运行所在页面」，错误数 2；展开见 message、栈与报错页面 ——
//     同步抛靠正文 try/catch 归属，异步抛靠栈里的脚本来源标记归属，两条都挂到本次运行上；
//   · 一条「@require 抓取」错误行：注册时抓 http://127.0.0.1:1/nope.js 失败（失败不阻断注入）。
//     它在保存的那一刻就产生，不必打开任何网页；
//   · 一条「GM 桥」错误行：下面那次参数非法的 GM_download 被桥在后台拒掉。
//     后两条不属于任何一次运行，故各自单独成行，不与运行行合并。
//   · 在脚本编辑器里改一个字符并保存，再回运行日志：保存之前那几次运行会标上「旧版源码」。
//
// 顺带演示一件「不采集」的事：脚本自己的 console.log 只进页面控制台，运行日志面板里找不到它。
//
// 本脚本 @match 是 *://*/*，看完请停用或删除，否则逢页报错。
;(function () {
  var ID = 'dl-run-log-demo'
  var el = document.getElementById(ID)
  if (!el) {
    el = document.createElement('div')
    el.id = ID
    el.style.cssText =
      'position:fixed;right:12px;bottom:150px;z-index:2147483647;padding:6px 10px;' +
      'border-radius:6px;background:#111;color:#f55;font:12px/1.4 ui-monospace,monospace'
    ;(document.body || document.documentElement).appendChild(el)
  }
  el.textContent = '运行日志样例 · 已报错'

  console.log('[运行日志样例] 本页：' + location.href)

  // 参数非法的能力调用：桥在后台直接拒掉，记一条「GM 桥」错误行。
  // 放在下一轮任务里发，等中继件就位；不用 onerror —— 桥的失败已经落在后台日志里了。
  setTimeout(function () {
    GM_download({ url: location.href, conflictAction: 'run-log-demo' })
  }, 0)

  setTimeout(function () {
    throw new Error('运行日志样例：异步运行期错误（按栈里的脚本来源标记归属到本次运行）')
  }, 0)
  throw new Error('运行日志样例：同步运行期错误（按正文 try/catch 归属到本次运行）')
})()
