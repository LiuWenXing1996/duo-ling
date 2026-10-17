# 0010. 浮层拖动：把手在父页、拖动只写 transform

日期: 2026-10-18
状态: 已接受
代码落点: packages/builtin-scripts/src/float-host/install.ts（拖动把手 JSDoc 指回本文件）

## 背景

浮层是对话框 iframe，拖动它的顶栏有两条**实测的坑**：

- 按在 iframe 里的鼠标手势会被 Chromium 一路路由给 iframe（浏览器级的拖拽捕获），父页用 pointer-events 让位 / 铺接管层都收不到后续事件——跨 iframe 接管指针走不通；
- 若退回「iframe 逐帧发位移消息」，跨进程一来一回延迟忽快忽慢，面板追一步顿一步；且逐帧改 fixed 元素的 left/top 会触发整页 style/layout/paint。

## 决策

- 把手是**父页盖在 iframe 顶栏上的一条**（`.dl-float-drag-strip`），整个拖动手势从按下到松手全程在本页完成，零跨进程消息。
- 拖动中只写 **transform**（合成器搬运，不重排），松手才把终位沉淀回 left/top。

## 代价与后果

- 把手 `right: 120px` 留出顶栏右侧三颗按钮，点击照常落进 iframe；
- 标题区被把手盖住，代价只是标题不响应悬停提示，无功能损失。
