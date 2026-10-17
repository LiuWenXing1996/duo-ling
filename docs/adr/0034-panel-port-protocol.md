# 0034. 面板端口协议独立成契约，不进命令面

日期: 2026-10-18
状态: 已接受
代码落点: packages/shared/src/panel-monitor.ts（文件头指针指回本文件）

## 背景

页面脚本监控的一条长连接（`duoling:panel`）有两个进程里的端点：SW 侧是 userscripts/page-monitor.ts，另一端是对话界面浮层的 use-page-monitor.ts（应用侧）。端口名或载荷形状只在一端改，另一端不会报错，只会**静默收不到东西**。

## 决策

- 协议（端口名 / 推送与快照形状）住契约包 `@duoling/shared`，两端同取。
- 一条长连接两个方向：SW → 面板推送（运行登记 / 错误 / 新文档清零 / 快照应答），面板 → SW 上行（按自己所属的 tab 拉一次快照）。
- 与 RuntimeRequest 的分工：那是**请求-应答命令面**，这条是长连接推送——不进那个联合，也不占总线 matcher（面板端口由 SW 自己 onConnect 接）。
