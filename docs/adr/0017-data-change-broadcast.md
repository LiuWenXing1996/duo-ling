# 0017. 数据变更广播：IndexedDB 无通知的补偿线

日期: 2026-10-18
状态: 已接受
代码落点: packages/shared/src/ipc/extension-ipc.ts（数据变更广播段指回本文件）

## 背景

项目状态库与会话都落在 IndexedDB，而 **IDB 没有变更通知**（chrome.storage 有 onChanged，IDB 没有）——「别处改了数据、这个页面还显示旧的」是结构性的必然，不是 bug。

## 决策

- 建一条**多播**通知线：同一工作台的其他标签页、另一个浏览器窗口的工作台、对话界面，全部收到。写侧落盘后发，读侧订阅回拉。
- 与 OffscreenPush 的分工：那是「一个特定接收方」的点对点推送（SW→offscreen 等）；这条是多播。
- **刻意不进 RuntimeRequest**：那里面全是「请求-应答」的命令，而广播没有应答方，塞进去会污染 extension-ipc.test.ts 的 kind 归属断言（每个 kind 恰被一端处理）。
- 形状真相源在 `@duoling/shared`（data-broadcast.ts）：频道与推送形状被运行时包（gm-bridge / cookie-gate）同取。
