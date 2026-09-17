// 页面上下文的**采集侧暂存**（侧边栏 / 扩展页上下文）：
// 「点选元素」动作的产物在这里等下一条消息一起发出
// （docs/proposals/done/element-picker.md「拾取器交互与载荷形态」）。
// 页面快照已改 AI 工具采集（2026-09-17 决策），不再走用户暂存通道。
//
// 为什么是模块级单例而非组件状态：chat:start 的 pageContext 在
// ExtensionChatTransport.collectPageContext 里组装（非组件树内），
// store 必须与 transport、UI 双方可达；用最小 pub/sub 让 chip UI 订阅刷新。

import type { ElementPickContext } from '@/shared/extension-ipc'

let element: ElementPickContext | null = null

const listeners = new Set<() => void>()

function notify(): void {
  for (const fn of listeners) fn()
}

/** 订阅变更（chip UI 渲染用）；返回取消订阅函数 */
export function subscribePageContext(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 当前暂存的拾取元素（null = 无） */
export function getPickedElement(): ElementPickContext | null {
  return element
}

/** 存入拾取结果（覆盖旧值；同一时刻至多一份） */
export function setPickedElement(ctx: ElementPickContext): void {
  element = ctx
  notify()
}

/** 清除拾取结果（chip 的 × / 发送后） */
export function clearPickedElement(): void {
  if (element == null) return
  element = null
  notify()
}

/** 组装进 chat:start 的 pageContext（与档 0 合并由 transport 负责）；有暂存才返回非空 element 字段 */
export function consumePendingPageContext(): { element?: ElementPickContext } {
  return element ? { element } : {}
}

/** 发送完成后清空暂存（上下文随消息发出，chip 不应残留） */
export function clearSentPageContext(): void {
  if (element == null) return
  element = null
  notify()
}
