// 件包的应用侧唯一出口：注册面（注册 id / 产物文件名）。
//
// 件的**本体**（recorder/install、inspector、float-host）刻意不从这里导出 ——
// 它们只被各自的 entry.ts 引用、由 esbuild 打进独立 IIFE 产物，应用侧取产物内容作系统脚本源码。
// 若从这里导出，SW 的 bundle 会顺着 re-export 把件源码拉进来（件源码要注入页面，不该同时住在 SW 里）。
// 中继件（relay/）同理只从自己的子路径出口（./builtin/relay 供 SW 测试取源码本体、
// ./builtin/relay-code.gen 供 SW 取 IIFE 字符串），不进这个桶。
//
// 跨世界的协议契约不在这里 —— 那是 @duoling/shared（api-contract）的职责：
// 三件内置件的指令信封随脚本桥协议走，不再各有各的 kind 常量。
//
// 于是消费面是两组：
//   · 应用侧（SW / UI / 测试）—— import 本模块，拿注册面；
//   · 件侧（件自己的单测）—— 直接以相对路径 import 件模块。

export * from './registry'
