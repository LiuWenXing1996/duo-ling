// SW 保活心跳的跨包契约与两端原语：发送侧在 @duoling/offscreen-document、
// 应答侧在 @duoling/service-worker，两端分属两包，靠这一份 ProtocolMap 对齐报文形状。
//
// 为什么走 @webext-core/messaging 而不是宿主总线：保活与用户脚本、与业务命令都无关，
// 是任何宿主都要的通用基础设施 —— 挂到宿主的命令面 matcher 上等于借宿主的位子。
// 库自带的 listener 与宿主总线**并列**，两者形状互斥、各认各的：
//   · 库报文 = { id, type, data, timestamp }，无 kind → 宿主总线「无 kind 即让路」；
//   · 总线报文 = { kind, … }，无 type/timestamp → 库对不合格式的报文同样让路。
// 故一条报文只可能被一端认领，谁都不会替对方抢答（sendResponse 一条消息只有一次机会）。
import { defineExtensionMessaging } from '@webext-core/messaging'

/** 保活心跳的消息 type（本库的报文键）；值即断线点，改它等于同时改发送侧与应答侧 */
export const IPC_SW_KEEPALIVE = 'background:keepalive'

/** 本包经手的协议面：新增 kind 在此登记，两端共用同一份声明 */
interface KeepaliveProtocol {
  [IPC_SW_KEEPALIVE](): { alive: true }
}

const { sendMessage, onMessage } = defineExtensionMessaging<KeepaliveProtocol>()

/** 发送端原语：一跳一次；SW 未就绪则 reject（调用方自吞，见 @duoling/offscreen-document） */
export function sendSwKeepalive(): Promise<{ alive: true }> {
  return sendMessage(IPC_SW_KEEPALIVE)
}

/** 应答端原语：认领保活，返回退订函数（生产路径不退订 —— 与 SW 同生命周期） */
export function onSwKeepalive(handler: () => { alive: true }): () => void {
  return onMessage(IPC_SW_KEEPALIVE, handler)
}
