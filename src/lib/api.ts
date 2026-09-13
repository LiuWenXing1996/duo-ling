// 扩展侧补充门面：PreloadApi 契约之外、平移组件用不到的接口。
//
// 桌面版的 window.api（src/shared/ipc.ts 的 PreloadApi）是「渲染层与主进程」的契约，
// 平移来的组件一字不改地用着它；而扩展侧还有几件事是桌面版没有对应物的，例如
// 「按 id 取工具页 HTML」——桌面版里这一步由 <webview src="tool://..."> 隐式完成，没有接口。
// 这类接口放在这里，不污染 PreloadApi 契约。
import type { GitCommitResult, RuntimeRequest } from '../shared/extension-ipc'

function send<T>(request: RuntimeRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response: { ok: boolean; data?: T; error?: string } | undefined) => {
      const lastError = chrome.runtime.lastError
      if (lastError) {
        reject(new Error(lastError.message))
        return
      }
      if (!response) {
        reject(new Error('background 无响应'))
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

export const extensionApi = {
  /** 工具页 HTML（工具详情 / 版本预览的 srcdoc 来源） */
  getToolPage: (toolId: string): Promise<string> => send({ kind: 'tool:getPage', toolId }),
  /** 执行一次能力（工具页经桥接调用） */
  runCapability: (toolId: string, capId: string, input: Record<string, unknown>): Promise<unknown> =>
    send({ kind: 'cap:run', toolId, capId, input }),
  /** 提交工具当前版本；无净变更时 committed=false（调用方据此提示「无变更」） */
  commitTool: (toolId: string, message: string): Promise<GitCommitResult> =>
    send({ kind: 'git:commit', toolId, message })
}
