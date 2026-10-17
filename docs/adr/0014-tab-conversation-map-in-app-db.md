# 0014. 标签页→会话映射存应用库 kv，不进会话记录

日期: 2026-10-18
状态: 已接受
代码落点: packages/shared/src/app/conversation-tab-map.ts（文件头指针指回本文件）

## 背景

「每个 tab 一条会话、切 tab 即切会话」需要一处 tab → conversationId 的归属映射。放哪决定了这条事实的性质会不会被写歪。

## 决策

- 落在**应用配置库 `duoling-app`** 的一个键（`convByTab`），而不是给 `Conversation` 加字段。判据：「哪个 tab 现在开着哪条会话」是本机的**界面状态**（与 side panel 展开态同类），不是会话的业务属性——tabId 易失（关掉即失去意义）、且会被浏览器复用，写进会话记录会让会话带上一份迟早要清理的外键。
- 键只用 tabId：Chrome 的 tab id 在**整个浏览器 session 内全局唯一**（不是 per-window），不需要 windowId 参与。
- 并发写用 `app-db.update` 的原子读-改-写：本表是整表一个键，而写方有两处（面板新建会话时登记 / SW 在 tab 关闭时移除），可能交错；拆成 get+set 会丢更新。
- 读侧容错：会话被删（或整库清空）后映射里会留陈旧项——`getConversationIdForTab` 只负责读出，**由调用方拿会话列表校验**（在列表里找不到就当未绑定）；写侧的删除路径也顺手清理（unbindConversation / unbindAll）。
- 「会话唯一写方 = offscreen」的不变量不受影响：本模块只读写 duoling-app 的 kv（扩展页 / SW 都可直连），不碰 duoling-chat。
