// chrome.runtime 的收发原语（回调形态 + lastError 同步读取的样板收拢）。
// 全扩展各运行时（SW / 扩展页 / offscreen document）通用：chrome.runtime 在这些上下文里都在场。
//
// 为什么在契约包：offscreen 进程包要在包里发命令（对话编排经 SW 代办），而包不能引应用源码。
// 这里只放**最底层**的收发 —— 信封解包与尽力而为的推送。带类型的总线（ipcRequest / ipcNotify /
// serveIpc，认 RuntimeRequest 联合）仍在应用侧的 src/shared/ipc-bus.ts，功能代码照旧只经它。
//
// 本包不吃 chrome 类型（tsconfig `types: []`），故就地取结构形状，与 data-broadcast-runtime 同款。

import type { IpcEnvelope } from './ipc/envelope'

/** chrome.runtime 里用得上的两个面（发送 + 回调内的 lastError） */
interface RuntimePort {
  sendMessage(message: unknown, callback?: (response: unknown) => void): Promise<unknown> | void
  lastError?: { message?: string }
}

function runtimePort(): RuntimePort | null {
  return (globalThis as { chrome?: { runtime?: RuntimePort } }).chrome?.runtime ?? null
}

/** 发一条报文并统一解包 { ok, data | error } 信封；失败 reject Error */
export function sendRuntime<T>(request: unknown): Promise<T> {
  const runtime = runtimePort()
  if (!runtime) return Promise.reject(new Error('chrome.runtime 不可用'))
  return new Promise<T>((resolve, reject) => {
    runtime.sendMessage(request, (raw) => {
      // lastError 必须在回调里同步读（chrome 的约定）
      const lastError = runtime.lastError
      if (lastError) {
        reject(new Error(lastError.message))
        return
      }
      const response = raw as IpcEnvelope<T> | undefined
      if (!response) {
        reject(new Error('扩展服务未响应，请重试'))
        return
      }
      if (!response.ok) {
        reject(new Error(response.error))
        return
      }
      resolve(response.data)
    })
  })
}

/** 单向推送（尽力而为）：无人接收不是错误，静默吞掉 */
export function notifyRuntime(message: unknown): void {
  const runtime = runtimePort()
  if (!runtime) return
  try {
    void Promise.resolve(runtime.sendMessage(message)).catch(() => {})
  } catch {
    // 发送期抛错（上下文已销毁等）：推送本就尽力而为
  }
}
