// 扩展内 IPC 的通用契约：所有请求-应答命令共用的应答信封。
//
// 为什么归本包：信封是各语境（SW / offscreen / 扩展页）与运行时包两半共用的形状，
// 放任何一侧都会形成「对侧只靠注释对齐」的漂移面。沿用本包铁律：只放两端必须逐字节
// 一致的东西，零 chrome.*、零 DOM 假设。
//
// 与 src/shared/extension-ipc.ts 的分工：那边是应用内部（SW / offscreen / 扩展页）的
// 全量命令面 RuntimeRequest；这里只锁所有命令共用的应答信封。
//
// 剪贴板写入不进本包：它已收进 OffscreenService（报文带 path / args、无 kind），
// 形状在本包的 service/offscreen-service。保活同理（报文无 kind，key 在 service/sw-service）。

/** 统一应答信封：所有请求-应答命令共用，调用方据 ok 分支 */
export type IpcEnvelope<T> = { ok: true; data: T } | { ok: false; error: string }
