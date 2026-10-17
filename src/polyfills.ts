// Node 风格库的运行时兜底：isomorphic-git / lightning-fs 依赖 `global` / `Buffer`。
// SW 与 offscreen 里这两个都不是全局对象，会读 undefined 崩溃，故在导入这类库之前先补齐。
// 两个入口（background.ts / offscreen-main.ts）都必须在最前面 import；本文件先补 process 再补 Buffer，
// 保证早于包内 isomorphic-git / lightning-fs 的引用执行。
import './polyfill-process' // 先补 process（buffer 包加载时会引用）
import { Buffer } from 'buffer'

const g = globalThis as unknown as Record<string, unknown>
if (typeof g.global === 'undefined') {
  g.global = globalThis
}
if (typeof g.Buffer === 'undefined') {
  g.Buffer = Buffer
}
