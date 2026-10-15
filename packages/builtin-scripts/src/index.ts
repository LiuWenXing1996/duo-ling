// 包的应用侧唯一出口：协议契约 + 注册面。
//
// 件的**本体**（relay/install、recorder/install、forwarder/install）刻意不从这里导出 ——
// 它们只被各自的 entry.ts 引用、由 esbuild 打进独立 IIFE 产物。若从这里导出，SW 的 bundle
// 会顺着 re-export 把件源码拉进来（件源码要注入页面，不该同时住在 SW 里）。
//
// 于是消费面是两组：
//   · 应用侧（SW / UI / 测试）—— import 本模块，拿协议常量与注册面；
//   · 件侧（件自己的单测）—— 直接以相对路径 import 件模块。

export * from './protocol/bridge'
export * from './protocol/tab-record'
export * from './protocol/inspector'
export * from './protocol/page-context'
export * from './registry'
