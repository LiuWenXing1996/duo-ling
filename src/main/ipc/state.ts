// 主进程跨领域共享的「生成中止」状态：agent 对话持有 AbortController，
// 退出前需要统一中止并等待。此模块用 getter/setter 封装模块级状态，供各 ipc 领域模块与 index 共享。
let agentAbortController: AbortController | undefined
let quitConfirmed = false

/** 是否有任何正在进行的生成（agent 对话） */
export function isGenerating(): boolean {
  return agentAbortController != null
}

/** 中止当前所有生成（agent 对话） */
export function abortCurrentGeneration(): void {
  agentAbortController?.abort()
}

export function getAgentAbortController(): AbortController | undefined {
  return agentAbortController
}

export function setAgentAbortController(controller: AbortController | undefined): void {
  agentAbortController = controller
}

export function getQuitConfirmed(): boolean {
  return quitConfirmed
}

export function setQuitConfirmed(value: boolean): void {
  quitConfirmed = value
}
