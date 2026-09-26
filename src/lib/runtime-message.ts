// SW 侧 runtime 消息「原始引用」持有者（轻量、无副作用、不 import VM 内核、不触发 importScripts）。
//
// 为什么需要它：VM 内核（common/browser.js）在 importScripts 时会改写 `chrome.runtime.sendMessage`
// 与 `chrome.runtime.onMessage.addListener`（见 vm-runtime-host 注释）。任何需要在 VM 改写后仍能
// 正常收发 runtime 消息的代码，必须走这里的原始引用，而非裸 `chrome.runtime.*`。
//
// 为什么独立成模块而不是复用 vm-runtime-host 的导出：vm-runtime-host 顶层会 `importScripts` 加载
// SW 专属的 VM 内核，把它 import 进 offscreen / 扩展页会直接炸（offscreen 没有 importScripts）。
// 本模块刻意保持纯净 —— data-broadcast 这种三环境通用模块也能安全 import，不会把 VM 内核带进去。
//
// 捕获时机：必须在 VM 改写之前完成。vm-runtime-host 在其 importScripts 之前调用 captureRuntimeRaw()，
// 而 vm-runtime-host 在 SW bundle 顶层被 background import，早于一切运行时调用，故 capture 必先行。
// 兜底：若某环境从未调用 capture（如纯前端、无 VM 改写），首次调用时 lazy 捕获，此时 chrome.runtime
// 未被改写，拿到的仍是原生引用，行为一致。

type RawSendMessage = typeof chrome.runtime.sendMessage
type RawOnMessageAdd = typeof chrome.runtime.onMessage.addListener
type RawOnMessageRemove = typeof chrome.runtime.onMessage.removeListener

let rawSendMessage: RawSendMessage | null = null
let rawOnMessageAdd: RawOnMessageAdd | null = null
let rawOnMessageRemove: RawOnMessageRemove | null = null
let captured = false

/** 在 VM 改写 chrome.runtime 之前调用一次，捕获原始引用。重复调用无副作用。 */
export function captureRuntimeRaw(): void {
  if (captured) return
  const onMessage = chrome.runtime.onMessage
  rawSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime)
  rawOnMessageAdd = onMessage.addListener.bind(onMessage)
  rawOnMessageRemove = onMessage.removeListener.bind(onMessage)
  captured = true
}

function ensureCaptured(): void {
  if (!captured) captureRuntimeRaw()
}

/** 用「VM 改写前捕获」的原始 chrome.runtime.sendMessage 发送（Promise 形态）。 */
export function rawSendRuntimeMessage<T = unknown>(request: unknown): Promise<T> {
  ensureCaptured()
  return rawSendMessage!(request as never) as Promise<T>
}

/** 用原始 onMessage.addListener 注册监听器（恢复原生 return true + 异步 sendResponse 契约）。 */
export function addRawRuntimeMessageListener(
  listener: (
    msg: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (r?: unknown) => void,
  ) => void,
): void {
  ensureCaptured()
  rawOnMessageAdd!(listener as never)
}

/** 对称注销（见 addRawRuntimeMessageListener）。 */
export function removeRawRuntimeMessageListener(
  listener: (
    msg: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (r?: unknown) => void,
  ) => void,
): void {
  ensureCaptured()
  rawOnMessageRemove!(listener as never)
}
