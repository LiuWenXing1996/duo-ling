// 主进程跨领域共享的「生成中止」状态：对话 chat 与工具生成器 generator 各自持有 AbortController，
// 退出前需要统一中止并等待。此模块用 getter/setter 封装模块级状态，供各 ipc 领域模块与 index 共享。
let chatAbortController: AbortController | undefined
let generatorAbortController: AbortController | undefined
let quitConfirmed = false

/** 是否有任何正在进行的生成（对话 + 生成器） */
export function isGenerating(): boolean {
  return chatAbortController != null || generatorAbortController != null
}

/** 中止当前所有生成（对话 + 生成器） */
export function abortCurrentGeneration(): void {
  chatAbortController?.abort()
  generatorAbortController?.abort()
}

export function getChatAbortController(): AbortController | undefined {
  return chatAbortController
}

export function setChatAbortController(controller: AbortController | undefined): void {
  chatAbortController = controller
}

export function getGeneratorAbortController(): AbortController | undefined {
  return generatorAbortController
}

export function setGeneratorAbortController(controller: AbortController | undefined): void {
  generatorAbortController = controller
}

export function getQuitConfirmed(): boolean {
  return quitConfirmed
}

export function setQuitConfirmed(value: boolean): void {
  quitConfirmed = value
}
