import type { GmMainOpts } from '../opts'

declare const __gmOpts: GmMainOpts
declare const chrome: any
declare const __gmBridge: any
declare function __gmHandleEvent(ev: any): void

var GM_INFO = __gmOpts.info
GM_INFO.userAgent = navigator.userAgent
try {
  GM_INFO.isIncognito = !!(
    typeof chrome !== 'undefined' &&
    chrome.extension &&
    chrome.extension.inIncognitoContext
  )
} catch (e) {
  GM_INFO.isIncognito = false
}
var GM_HAS = __gmOpts.has
var GM_VALUES = __gmOpts.values
var GM_RESOURCES = __gmOpts.resources
var NAME_PREFIX = '[GM:' + __gmOpts.name + ']'

__gmBridge.onEvent(function (ev: any) {
  __gmHandleEvent(ev)
})

var __gmRunId = (function () {
  try {
    return crypto.randomUUID()
  } catch (e) {
    return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  }
})()
var __gmSrcSavedAt = __gmOpts.savedAt
function __gmAnnounceRun() {
  try {
    var p = __gmBridge.emit({
      kind: 'runstart',
      name: GM_INFO.script.name,
      runId: __gmRunId,
      url: location.href,
      savedAt: __gmSrcSavedAt,
    })
    if (p && typeof p.catch === 'function') p.catch(function () {})
  } catch (e) {}
}
__gmAnnounceRun()
if (document.readyState !== 'complete') window.addEventListener('load', __gmAnnounceRun)

function __gmLog() {
  try {
    console.log.apply(console, [NAME_PREFIX].concat([].slice.call(arguments)))
  } catch (e) {}
}

var __gmSrcMark = __gmOpts.srcMark
function __gmOwnStack(stack: any) {
  return typeof stack === 'string' && stack.indexOf(__gmSrcMark) !== -1
}
function __gmReportError(message: any, stack: any, url: any) {
  try {
    var p = __gmBridge.emit({
      kind: 'notice',
      name: GM_INFO.script.name,
      event: {
        t: 'error',
        phase: 'runtime',
        message: message,
        stack: stack,
        url: url,
        runId: __gmRunId,
      },
    })
    if (p && typeof p.catch === 'function') p.catch(function () {})
  } catch (e) {
    console.warn('[duoling:userscript] 上报异常：' + ((e && e.message) || e))
  }
}
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
  __gmReportError(
    'Unhandled rejection: ' + ((r && r.message) || String(e.reason)),
    stack,
    location.href,
  )
})
