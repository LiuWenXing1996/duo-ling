# 0027. SW 消息路由白名单：只应答登记过的 kind 前缀

日期: 2026-10-18
状态: 已接受
代码落点: src/entrypoints/background.ts（SW_KIND_PREFIXES 处 JSDoc 指回本文件）

## 背景

offscreen 与 SW 同时在监听 runtime 消息，而 sendResponse 对一条消息只有一次机会——SW 若抢答，会把 offscreen 的响应挤掉。

## 决策

- SW 只应答白名单里登记的 kind 前缀，其余（offscreen 的 fs: / conv: / chat:）必须让路。
- 新增命令时若忘了登记前缀，该命令会**静默无响应**（而不是报「未知消息类型」）——这是刻意的：静默比一个假错误更诚实。
- export 仅供协议一致性测试（extension-ipc.test.ts）做 kind 归属断言。

## 后果

新增命令的 checklist 里必须有「登记 SW / OFFSCREEN 前缀」这一步；协议测试保证两端归属不漂。
