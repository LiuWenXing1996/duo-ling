# Agent 协作指南

> 一句话：面向本仓库 AI 代理的协作约定——怎么干、写哪、分支保护。
> 源文档：[AGENTS.md](../../AGENTS.md)

## 现状

- 常驻命令集：项目速览、常用命令表、文档职责总表、全局约束（隐私/调试方法论）、分支保护。
- `main` 分支保护：任何改动必须走 PR，禁直推；合并前置门禁 = `typecheck` + 全部单测（`strict: true`，约束 admin）。
- AI 开工顺序：读 AGENTS → 文档总表 → 相关文档 → `.workbuddy/memory/`（本机上下文，不入库）；重大变更的决策理由记进 notes/content/conventions.md。
- 记录归属：常青规范 → notes 常青篇；问题 → inbox；踩坑 → lessons；生效约定与决策理由 → conventions；本机临时状态 → `.workbuddy/memory/`（不入库，不承载项目知识）。
- 隐私硬规则：落盘前脱敏（相对路径、`<用户名>` 等占位符；完整清单见 AGENTS.md）。

## 本文档不包括什么

- 直推 `main`（含 refspec 绕过法，会被 `GH006` 拒）。
- 把 E2E 设成 required status check（PR 上永远不上报，会卡死合并不了）。

## 决策记录

| 决策时间 | 决策点（≤100字） | 结论（≤100字） | 依据（≤100字） |
| --- | --- | --- | --- |
|  | main 分支保护 | 任何改动走 PR、禁直推 | 团队标准 Ruleset，对所有人含 admin 生效 |
| 2026-09-18 20:45:32 | dev-log 机制去留 | 整目录移除，6 篇日志只留 git 历史 | 时序流水与 notes 职责重叠，写入无边界、无校验 |
