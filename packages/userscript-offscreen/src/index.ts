// GM 运行时 offscreen 侧宿主：把「接入本包」的 offscreen 接线压到一行调用。
//
//  · createOffscreenHost —— 保活心跳 + 剪贴板命令应答（见 host.ts）。
//  · GM_OFFSCREEN_REASONS —— offscreen 文档的 reason 集（宿主建文档时取用）。
//  · 保活心跳的发送原语（startSwKeepalive / stopSwKeepalive）一并透出：
//    宿主若自管心跳时机可直调；默认 createOffscreenHost 已启动。

export { createOffscreenHost, GM_OFFSCREEN_REASONS, type OffscreenHost } from './host'
export {
  startSwKeepalive,
  stopSwKeepalive,
  SW_KEEPALIVE_INTERVAL_MS,
} from './keepalive'
