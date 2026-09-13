// Service worker 运行时兜底（第一优先）：Node 风格库（isomorphic-git / lightning-fs）依赖 `process`。
// service worker 没有 Node 的 process，需先补上，再让 `buffer` 包加载（它加载时会引用 process）。
// 必须在本模块之后才 import 'buffer'，故 background.ts 里本模块要在 polyfills.ts 之前。
import process from 'process'

const g = globalThis as unknown as Record<string, unknown>
if (typeof g.process === 'undefined') {
  g.process = process
}
