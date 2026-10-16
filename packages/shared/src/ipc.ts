// 扩展内 IPC 的通用契约：统一信封 + 运行时包自管命令面的 kind 与载荷形状。
//
// 为什么归本包：信封与剪贴板 kind 被分拆后的运行时包两半（sw 发送 / offscreen 应答）
// 同时消费，放任何一侧都会形成「对侧只靠注释对齐」的漂移面。沿用本包铁律：
// 只放两端必须逐字节一致的东西，零 chrome.*、零 DOM 假设。
//
// 与 src/shared/extension-ipc.ts 的分工：那边是应用内部（SW / offscreen / 扩展页）的
// 全量命令面 RuntimeRequest；这里只锁「运行时包自带的命令」与所有命令共用的应答信封。
// 字面量值保持与既有线路一致（clipboard:write），改了就是断线。
//
// 保活不走本包：报文无 kind，key 在 proxy-service-list。

/** 统一应答信封：所有请求-应答命令共用，调用方据 ok 分支 */
export type IpcEnvelope<T> = { ok: true; data: T } | { ok: false; error: string }

/** 剪贴板写命令（SW → offscreen）：offscreen 内免手势直写，富文本走 text/html */
export const IPC_CLIPBOARD_WRITE = 'clipboard:write'

/** 剪贴板写命令的载荷（至少 text / html 之一；消费侧校验，类型层放最宽） */
export interface ClipboardWriteMessage {
  kind: typeof IPC_CLIPBOARD_WRITE
  text: string | null
  html: string | null
}
