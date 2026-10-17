// 全局环境声明（ambient）。
//
// 注意：本文件**不能出现顶层 import/export**，否则会变成 module，
// 其中 `declare module 'process'` 会退化为「模块增强」而不再是「模块声明」，
// 表现为 polyfill-process.ts 报 TS7016（找不到 process 的类型声明）。

// `process` 包只有 CommonJS 实现、不带类型，而 service worker 需要它做全局兜底（见 src/polyfill-process.ts）。
declare module 'process' {
  interface ProcessLike {
    env: Record<string, string | undefined>
    nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void
    version?: string
    browser?: boolean
    platform?: string
  }
  const process: ProcessLike
  export default process
}

/**
 * 构建期 vite.define 注入的裸标识符（wxt.config.ts 的 vite.define）：
 * 编译期被替换成字面量、写进 JS bundle，**不受 extension_pages CSP 限制**，
 * 是页面 / SW / offscreen 三处都能用的构建信息来源。
 * 声明为联合 undefined：未应用该 define 的环境（如 vitest）里它不存在，
 * 调用方须用 `typeof __BUILD_INFO__ !== 'undefined'` 兜底（typeof 读不存在的标识符不抛错）。
 */
declare const __BUILD_INFO__:
  | { time: string; branch: string; version: string; repo: string }
  | undefined
