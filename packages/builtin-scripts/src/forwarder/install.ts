// 标签页录制 · USER_SCRIPT 世界转发件本体。
//
// 存在理由：MAIN 件没有 chrome.*，采集后只能 window.postMessage 给同帧；
// 而 postMessage 跨世界（MAIN ↔ USER_SCRIPT 共享同一个 window）是通的 ——
// 通道形态与脚本桥那对（script-bridge → 中继件）一样。本件职责单一：把该标签的消息转给 SW。
//
// 安全性：本件只做「转发」，不做任何判断 —— 既不看种类、也不看内容（种类分流在 SW 侧，
// 那才是信任边界）。归属同样不在这里声明：录制按标签页，SW 用 sender.tab.id 自己认。
//
// 本件没有运行期参数，故注册时只需一个 IIFE 文件（无装配段）。
// 世界要求：独立世界（worldId: 'us-dl-tab'）且必须 configureWorld({ messaging: true })。

import { TAB_RECORD_TAG } from '../protocol/tab-record'

declare global {
  interface Window {
    /** 幂等守卫：同一 realm 被注入两次也只装一遍 */
    __dlTabForwarder?: boolean
  }
}

export function installTabForwarder(): void {
  if (window.__dlTabForwarder) return
  window.__dlTabForwarder = true

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return // 只收本帧（MAIN 件的 postMessage 目标是本帧）
    const d = e.data as Record<string, unknown> | null
    if (!d || d[TAB_RECORD_TAG] !== true || typeof d.kind !== 'string' || !d.record) return
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return
      const out: Record<string, unknown> = { kind: d.kind, record: d.record }
      out[TAB_RECORD_TAG] = true
      chrome.runtime.sendMessage(out, () => {
        void chrome.runtime.lastError // 后台未就绪 / SW 重启窗口：静默丢弃这条，不重试
      })
    } catch {
      /* 世界未开 messaging：静默（与错误上报同款兜底） */
    }
  })
}
