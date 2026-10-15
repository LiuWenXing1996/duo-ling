// 件包的应用侧唯一出口：注册面（注册 id / 独立世界 id / 产物文件名 / 装配段）。
//
// 件的**本体**（recorder/install、inspector、float-host）刻意不从这里导出 ——
// 它们只被各自的 entry.ts 引用、由 esbuild 打进独立 IIFE 产物。若从这里导出，SW 的 bundle
// 会顺着 re-export 把件源码拉进来（件源码要注入页面，不该同时住在 SW 里）。
// 中继件（relay）已随 `@duoling/userscript-runtime` 包内化，不在这里。
//
// 跨世界的协议契约不在这里 —— 那是 @duoling/shared 的职责：件与应用两侧同取那一处的
// 常量与形状，包内件直接 import 那个包。
//
// 于是消费面是两组：
//   · 应用侧（SW / UI / 测试）—— import 本模块，拿注册面；
//   · 件侧（件自己的单测）—— 直接以相对路径 import 件模块。

export * from './registry'
