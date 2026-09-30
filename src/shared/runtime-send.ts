// chrome.runtime.sendMessage 的 Promise 包装（回调形态 + lastError 同步读取的样板收拢）。
// 全扩展各运行时（SW / 扩展页 / offscreen document / content script）通用：
// chrome.runtime 在这些上下文里都在场。
import type { RuntimeRequest, RuntimeResponse } from './extension-ipc'

/** 发一条 RuntimeRequest 并统一解包 { ok, data | error } 信封；失败 reject Error */
export function runtimeSend<T>(request: RuntimeRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response: RuntimeResponse<T> | undefined) => {
      // lastError 必须在回调里同步读（chrome 的约定）
      const lastError = chrome.runtime.lastError
      if (lastError) {
        reject(new Error(lastError.message))
        return
      }
      if (!response) {
        reject(new Error('扩展服务未响应，请重试'))
        return
      }
      if (!response.ok) {
        reject(new Error(response.error))
        return
      }
      resolve(response.data as T)
    })
  })
}
