# 0008. 内置件构建：IIFE 单文件

日期: 2026-10-18
状态: 已接受
代码落点: packages/builtin-scripts/esbuild.config.mjs（文件头指针指回本文件）

## 背景

chrome.userScripts 的 `js[]` 只认两种注入——`{ file }`（扩展内路径，浏览器直接跑）与 `{ code }`（字符串）。内置件以文件形态分发，就必须自包含、无 import/export 残留。

## 决策

- bundle + format=iife，每件一个自包含单文件。
- 入口表的**键即产物文件名**（relay → dist/relay.js）；`{ file }` 的字面量在 registry.ts 里声明，两边改名必须同步——registry.test.ts 比对产物与注册面是否对得上。

## 备选与否决

- **开 splitting**：iife 不支持代码分割（esbuild 只在 esm 下才允许）；且 userScripts 按世界注入，件之间本来就无法共享模块实例。

## 代价与后果

- 共享的协议代码会被复制进引用它的每个件——躲不掉，接受。
