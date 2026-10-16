// chrome.runtime.sendMessage 的 Promise 包装（回调形态 + lastError 同步读取的样板收拢）。
// 全扩展各运行时（SW / 扩展页 / offscreen document）通用：
// chrome.runtime 在这些上下文里都在场。
//
// **本文件是标准信道的内层实现，只该被 @/shared/ipc-bus 引用**：功能代码一律经 ipc-bus 的
// ipcRequest（带可选超时）/ ipcNotify 发送，不得直接 import 本模块（否则「发送口只有 ipc*」
// 的叙事就破了）。ipc-bus 把发送原语收在一处，本模块只负责最底层的信封解包。
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
