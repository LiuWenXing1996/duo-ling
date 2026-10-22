# 0028. IPC 接收侧留在应用层、发送侧在契约包

日期: 2026-10-18
状态: 已接受
代码落点: src/shared/ipc-bus.ts（文件头指针指回本文件）

## 背景

IPC 的发送 / 订阅在 @duoling/shared（ipcRequest / ipcNotify / ipcSubscribe），接收侧却不能也放契约包。

## 决策

- 接收侧留应用层：matcher 的 handle 收 `chrome.runtime.MessageSender`——那是 chrome 的类型面，而契约包 tsconfig 是 `types: []`（零 chrome 类型，避免 SW 误用 node / 页面误用 chrome 那类错配被类型系统放过）。
- 接收侧形态：每语境唯一的 onMessage 监听器 + 三种 matcher，数组依次问询，**第一个认领的应答**（sendResponse 一条消息只有一次机会，多端都接会抢答）。
- 包自管的 kind（管理面只读四条，见 0035）以 pack matcher 形式插在最前，归各包应答——宿主前缀路由不得抢答；其余 kind 归宿主前缀表（`SW_KIND_PREFIXES`；0045 起 offscreen 不再挂接收口，另一张表已并回）。
