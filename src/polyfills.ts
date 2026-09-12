// Service worker 运行时兜底：Node 风格库（isomorphic-git / lightning-fs）依赖 `global` / `Buffer`。
// service worker 里 `global` / `Buffer` 都不是全局对象，会读 undefined 崩溃。这里在导入任何这类库之前先补齐。
// 必须在 background.ts 最前面 import，且本文件 import 了 polyfill-process（先补 process）再补 Buffer，
// 保证早于 fs-store 的 isomorphic-git / lightning-fs 引用执行。
import './polyfill-process' // 先补 process（buffer 包加载时会引用）
import { Buffer } from 'buffer'

const g = globalThis as unknown as Record<string, unknown>
if (typeof g.global === 'undefined') {
  g.global = globalThis
}
if (typeof g.Buffer === 'undefined') {
  g.Buffer = Buffer
}
