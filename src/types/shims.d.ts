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
 * 从桌面版平移来的 UI 组件直接调用 `window.api.*`：
 * 桌面版由 preload 经 contextBridge 注入（权威形状见 src/shared/ipc.ts 的 PreloadApi）；
 * 扩展版没有 preload，改由 src/lib/window-api.ts 装配后挂载到 window。
 * 这里补上全局声明（`import(...)` 类型语法不引入顶层 import，保持本文件 ambient），
 * 组件侧因此无需任何改动。
 */
interface Window {
  api: import('@/shared/ipc').PreloadApi
  // 构建信息（wxt.config.ts 注入）：版本号 + 分支 + 时间，用于 UI 展示「装的是哪个版本 / 跑的是哪次构建」。
  __BUILD_INFO__?: { time: string; branch: string; version: string }
}
