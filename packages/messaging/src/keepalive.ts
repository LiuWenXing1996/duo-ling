// SW 保活心跳的跨包契约：发送侧在 @duoling/offscreen-document、应答侧在
// @duoling/service-worker，两端分属两包 —— 字面量放任何一侧都只能靠注释对齐。
//
// 值即断线点：改它等于同时改发送侧与应答侧。
export const IPC_SW_KEEPALIVE = 'background:keepalive'

/** 保活心跳报文：只证明「SW 活着」，不做任何检测 */
export interface KeepaliveMessage {
  kind: typeof IPC_SW_KEEPALIVE
}
