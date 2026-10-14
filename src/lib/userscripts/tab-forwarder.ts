// 标签页录制 · USER_SCRIPT 世界转发件（机制层）。
//
// buildTabForwarderSource() 返回的字符串由 engine.ts 在注册 dl-tab-forwarder 时注入
// 独立 USER_SCRIPT 世界（worldId: 'us-dl-tab'，须 configureWorld({ messaging: true })）。
//
// 存在理由：MAIN 件没有 chrome.*，采集后只能 window.postMessage 给同帧；
// 而 postMessage 跨世界（MAIN ↔ USER_SCRIPT 共享同一个 window）是通的——
// 通道形态与 script-bridge → script-relay 那对一样（同帧 postMessage）。本件职责单一：把该标签消息转给 SW。
//
// 安全性：本件只做「转发」，不做任何判断——既不看种类、也不看内容（种类分流在 SW 侧，
// 那才是信任边界）。归属同样不在这里声明：录制按标签页，SW 用 sender.tab.id 自己认。

import { TAB_RECORD_TAG } from './tab-record-protocol'

export function buildTabForwarderSource(): string {
  return `
;(function () {
  var TAG = ${JSON.stringify(TAB_RECORD_TAG)}
  if (window.__dlTabForwarder) return
  window.__dlTabForwarder = true

  window.addEventListener('message', function (e) {
    if (e.source !== window) return // 只收本帧（MAIN 件的 postMessage 目标是本帧）
    var d = e.data
    if (!d || d[TAG] !== true || typeof d.kind !== 'string' || !d.record) return
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) return
      var out = { kind: d.kind, record: d.record }
      out[TAG] = true
      chrome.runtime.sendMessage(out, function () {
        void chrome.runtime.lastError // 后台未就绪 / SW 重启窗口：静默丢弃这条，不重试
      })
    } catch (e) { /* 世界未开 messaging：静默（与错误上报同款兜底） */ }
  })
})();`
}
