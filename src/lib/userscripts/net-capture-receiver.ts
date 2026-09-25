// 网络录制入站接收（duo-ling 原生抓包特性，与 VM 注入的 GM 桥解耦）。
//
// 数据流：net-recorder（MAIN 世界捕获件）经 window.postMessage 把采集交给
// net-forwarder（USER_SCRIPT 世界，worldId 'us-dl-net'），后者再经
// chrome.runtime.sendMessage({ __dlNetCapture }) 送到本文件落库。
//
// 原先本文件（dl-bridge.ts）还承载「GM API 桥（dispatch）」与「运行监控
// （__dlRunStart / __dlEvent）」，二者随自研引擎废弃、改为读 VM（Phase D），
// 此处收敛为单一职责：网络录制接收。
//
// 安全性：载荷形状不可信（经页面可伪造的 postMessage + 两次结构化克隆），故先过
// normalizeCapture 白名单化；无响应，仅落库，失败静默（录制不该影响页面网络层）。
import { normalizeCapture } from './net-record-protocol'
import * as netlog from './netlog-db'

let initialized = false

/** 注册网络录制接收监听（幂等：SW 闲置重启后会再次 init，避免重复监听） */
export function initNetCaptureReceiver(): void {
  if (initialized) return
  initialized = true

  chrome.runtime.onUserScriptMessage.addListener((raw, _sender, _sendResponse) => {
    const net = raw as { __dlNetCapture?: true; host?: string; capture?: unknown }
    if (net && net.__dlNetCapture === true) {
      const record = normalizeCapture(net.host, net.capture)
      if (record) void netlog.appendCapture(record).catch(() => {})
    }
    // 非录制消息（如 VM 运行时的 GetInjected / 内核命令）：不响应、不占响应权，
    // 避免挤掉真正应答方的响应通道。
    return undefined
  })
}
