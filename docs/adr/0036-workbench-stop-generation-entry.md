# 0036. 工作台「会话历史」必须能就地停止生成

日期: 2026-10-18
状态: 已接受
代码落点: packages/workbench/src/components/SessionHistoryTab.vue（stopGeneration JSDoc 指回本文件）

## 背景

会话按标签页归属，但任务跑在 offscreen、与页面无关——用户可能正在工作台翻历史（压根没打开那个标签页的浮层）。不给入口就等于只能看着它在后台烧 token。

## 决策

- 工作台「会话历史」里提供就地停止入口，直接给 SW 发停止命令。
- **停完不动本地状态**：状态归 SW（`chat:finished` 广播回来会触发重拉），这里只发命令、不做第二套口径。
