// Node 风格库的运行时兜底（第一优先）：isomorphic-git / lightning-fs 依赖 `process`。
// SW 与 offscreen 都没有 Node 的 process，需先补上，再让 `buffer` 包加载（它加载时会引用 process）。
// 由 polyfills.ts 保证导入顺序（本模块先于 'buffer'），两个入口只需 import polyfills.ts。
import process from 'process'

const g = globalThis as unknown as Record<string, unknown>
if (typeof g.process === 'undefined') {
  g.process = process
}
