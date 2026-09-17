# 插件迁移方案

> 一句话：Electron 桌面版 → Chrome MV3 扩展的架构映射、分层方案、风险清单。
> 源文档：[docs/plugin-migration-plan.md](../../docs/plugin-migration-plan.md)

## 现状

- 迁移已完成（2026-09-14）；剩余 Firefox `sidebar_action` 三期适配，§5 风险清单仍作参照。
- 三层难度：原子能力契约/UI/AI 编排可平移；存储与承载需替换（fs→IndexedDB、`<webview>`→sandbox iframe）；文件/系统能力必须改语义（任意路径访问消失）。
- 构建 WXT 0.21；存储 = `duoling-state` 状态库 + lightning-fs + `chrome.storage.local`；git 是历史侧车（仓损坏只丢历史不丢脚本）。

## 本文档不包括什么

- 进程级隔离（退化为 Web Worker 软隔离，边界靠白名单 + CSP）。
- 系统文件夹浏览（`shell.openPath` 删除）。

## 决策记录

| 决策时间 | 决策点 | 结论 | 依据（一句） |
| --- | --- | --- | --- |
| 2026-09-13 | 方案评审 | 方向成立，工作量上调至 0.8–1.0× 桌面版 | 异步改造 + 安全/清理一致性 + 测试链路被低估 |
| 2026-09-14 | 迁移完成 | 转用户脚本方向落地 | 工具链移除，核心闭环在扩展内成立 |
