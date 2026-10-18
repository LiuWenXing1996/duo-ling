// gm-main 注入源 · 开头段（页面世界真源码）。
// 动态常量（GM_info / 成员裁剪表 / 值快照 / @resource / 脚本名 / savedAt / 源标记）都在
// __gmOpts 里 —— SW 注册侧在 IIFE 最前面注入 `var __gmOpts = {...}` 与桥客户端内联
// （见 ../index.ts 的 gmDynamicHead），本段负责读取、页面侧补齐（userAgent / 隐身）与
// 错误收集的两层口径（同步 catch / 异步栈过滤）。
import type { GmMainOpts } from '../opts'

declare const __gmOpts: GmMainOpts
// MAIN 世界没有 chrome.*（唯一「擦边」访问是隐身上下文探测，恒被 try 包住）
declare const chrome: any
declare const __dlBridge: any
// 通道段声明（同一注入作用域，见该段文件头）
declare function __gmHandleEvent(ev: any): void

var GM_INFO = __gmOpts.info
// userAgent 只能在页面里取（页面 UA 未必等于 SW 的 UA），注册侧不传、注入时就地补齐
GM_INFO.userAgent = navigator.userAgent
// MAIN 世界没有 chrome.*，隐身上下文取不到 —— 恒 false（要拿真值需经桥回 SW 查，暂不做）
try {
  GM_INFO.isIncognito = !!(typeof chrome !== 'undefined' && chrome.extension && chrome.extension.inIncognitoContext)
} catch (e) {
  GM_INFO.isIncognito = false
}
var GM_HAS = __gmOpts.has
// 值快照：注册时刻的全量值。同步读只认它；写过之后本地缓存立即更新（见 store 段的 __gmSetSync）。
var GM_VALUES = __gmOpts.values
// @resource 内容：名 → { text, url(data URI) }。**同步 API 直接读它、不经桥** ——
// 内容由注册/注入路径抓好后随本前缀一起注入（见 resource-cache.ts 与 engine.ts）。
var GM_RESOURCES = __gmOpts.resources
var NAME_PREFIX = '[GM:' + __gmOpts.name + ']'

// —— 扩展侧通道：MAIN 世界没有 chrome.*，一切经同帧中继件（bridge-protocol.ts）。
//    必须先于任何调用到位 —— 下面的 __gmAnnounceRun() 是立即调用的。——
__dlBridge.onEvent(function (ev: any) {
  __gmHandleEvent(ev)
})

// —— 运行标识：**一次页面加载 = 一次运行**。注入即 mint，随错误记录上报并广播给 SW
//    （对话界面页面监控据此按 tab 登记运行）——
var __gmRunId = (function () {
  try {
    return crypto.randomUUID()
  } catch (e) {
    return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  }
})()
// 本版源码的保存时刻（注册侧常量，经 __gmOpts 下发）；不传即为 null（日志留空）
var __gmSrcSavedAt = __gmOpts.savedAt
function __gmAnnounceRun() {
  try {
    var p = __dlBridge.emit({
      __dlRunStart: true,
      name: GM_INFO.script.name,
      runId: __gmRunId,
      // 广播时刻的地址：load 补播与首次广播同属一个文档，SPA 内导航改的是它，取当下值即可
      url: location.href,
      savedAt: __gmSrcSavedAt,
    })
    if (p && typeof p.catch === 'function') p.catch(function () { /* 中继件未就位：丢弃 */ })
  } catch (e) { /* 同上 */ }
}
__gmAnnounceRun()
// load 时补播一次：脚本可能被配成 document_start，极早的广播会赶在 SW 唤醒前丢失
if (document.readyState !== 'complete') window.addEventListener('load', __gmAnnounceRun)

function __gmLog() {
  try { console.log.apply(console, [NAME_PREFIX].concat([].slice.call(arguments))) } catch (e) {}
}

// —— 运行期错误收集（写 errors 表，活动历史里可见）——
// 归属是两层口径（同步靠 catch、异步靠栈过滤，缺一不可）：
//   · **同步**：正文（含 @require）整体包进 try 块（自此到闭合后缀的 catch），catch 到的
//     即为己出，直报不判栈 —— 栈过滤对无栈错误无能为力，这层是补位；
//   · **异步**：回调 / promise 里抛的错 try 管不到，落回 window 的 error /
//     unhandledrejection —— 但这两个监听是**全页共享**的，错误事件不携带来源信息，
//     页面自身的报错也会撞进来（无法与「脚本触发的」区分）。故只认栈帧带本脚本
//     sourceURL 标记的：engine 给整条注入体拼 //# sourceURL=duoling://script/<uuid>/…，
//     正文、@require 与包装层同属一个脚本源，它们的帧都带该标记；标记含 uuid，
//     多脚本同页时各包装层只认自己的，互不冒领。
// 刻意接受的盲区：无栈错误（throw 'str' / Promise.reject('str')）与跨域 Script error
// 的栈里没有标记，异步层收不到 —— 宁可漏报，不收页面噪声。
var __gmSrcMark = __gmOpts.srcMark
function __gmOwnStack(stack: any) {
  return typeof stack === 'string' && stack.indexOf(__gmSrcMark) !== -1
}
function __gmReportError(message: any, stack: any, url: any) {
  try {
    var p = __dlBridge.emit({
      __dlEvent: true,
      name: GM_INFO.script.name,
      event: { t: 'error', phase: 'runtime', message: message, stack: stack, url: url, runId: __gmRunId },
    })
    // 必须吞掉失败：reject 会触发 unhandledrejection，又回到本函数形成自触发循环
    if (p && typeof p.catch === 'function') p.catch(function () { /* 桥不可用：丢弃 */ })
  } catch (e) {
    console.warn('[duoling:userscript] 上报异常：' + ((e && e.message) || e))
  }
}
// 正文同步错误的落点（闭合后缀的 catch 调它）：被 catch 即归属，无需再判栈
function __gmReportCaught(e: any) {
  __gmReportError((e && e.message) || String(e), (e && e.stack) || '', location.href)
}
window.addEventListener('error', function (e) {
  var err = e.error || {}
  var stack = (err && err.stack) || ''
  if (!__gmOwnStack(stack)) return // 页面自身的报错：不归属本脚本
  __gmReportError(e.message || 'Script error', stack, location.href)
})
window.addEventListener('unhandledrejection', function (e) {
  var r = e.reason || {}
  var stack = (r && r.stack) || ''
  if (!__gmOwnStack(stack)) return
  __gmReportError('Unhandled rejection: ' + ((r && r.message) || String(e.reason)), stack, location.href)
})
