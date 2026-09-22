// 网络录制 · USER_SCRIPT 世界转发件源码模板。
//
// buildNetForwarderSource() 返回的字符串由 engine.ts 在注册 dl-net-forwarder 时注入
// 独立 USER_SCRIPT 世界（worldId: 'us-dl-net'，须 configureWorld({ messaging: true })）。
//
// 存在理由：MAIN 捕获件没有 chrome.*，捕获后只能 window.postMessage 给同帧；
// 而 postMessage 跨世界（MAIN ↔ USER_SCRIPT 共享同一个 window）是通的——
// 通道形态与 script-bridge → script-relay 那对一样（同帧 postMessage）。本件职责单一：把该标签消息转给 SW。
//
// 安全性：本件只做「转发」，不做任何判断；host 用它自己的 location.hostname 现取。

import { NET_CAPTURE_TAG } from './net-record-protocol'

export function buildNetForwarderSource(): string {
  return `
;(function () {
  var TAG = ${JSON.stringify(NET_CAPTURE_TAG)}
  if (window.__dlNetForwarder) return
  window.__dlNetForwarder = true

  function host() {
    try { return String(window.location.hostname || '') } catch (e) { return '' }
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window) return // 只收本帧（捕获件的 postMessage 目标是本帧）
    var d = e.data
    if (!d || d[TAG] !== true || !d.capture) return
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) return
      chrome.runtime.sendMessage({ __dlNetCapture: true, host: host(), capture: d.capture }, function () {
        void chrome.runtime.lastError // 后台未就绪 / SW 重启窗口：静默丢弃这条，不重试
      })
    } catch (e) { /* 世界未开 messaging：静默（与错误上报同款兜底） */ }
  })
})();`
}
