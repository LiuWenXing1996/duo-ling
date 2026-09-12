// vitest 全局 setup：jsdom 未实现 ResizeObserver / IntersectionObserver，
// 而 `vue-stick-to-bottom`（ai-elements Conversation 底层）在挂载时会创建它们，
// 这里注入最小 stub 以支持在 jsdom 中渲染聊天区。
class ObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ObserverStub as unknown as typeof ResizeObserver
globalThis.IntersectionObserver = ObserverStub as unknown as typeof IntersectionObserver
