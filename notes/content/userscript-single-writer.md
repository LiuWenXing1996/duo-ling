# 脚本存储单写方

> 一句话：项目数据迁 offscreen 单写，统一进独立 IDB 库 `duoling-state`。

## 现状

- 已实现（2026-09-15）：项目数据（源码 / 配置 / 产物 / `enabled`）迁出 `chrome.storage`，改存 offscreen 持有的独立 IndexedDB 库 `duoling-state`（schema v1，库名 `duoling-state`、对象仓 `projects`）。
- SW 直读该库做全量注册（裸 IDB 多上下文共享，不经 offscreen）；写全部经 offscreen（单写方）；UI 读直读、写经 offscreen。一次保存 = 同一处先写状态库再 commit 仓，失败可重试可回滚。
- 划出：`DL.store` 值（`us:gm:*`）、`us:errors` 仍由 SW 直写 `chrome.storage.local`（写入不受控、不参与「脚本是什么」的真相判定）。
- 写命令面用 `state:` 新前缀（offscreen 应答，SW 静默让路）；`userscript:*` 仍是 UI 唯一入口、SW 转发——「注册」只 SW 能做，挂在写路径末尾。
- 前置项实测通过：SW 冷启动可读 IDB；清浏览数据两边抗清理一致；`offscreen:ensure` 冷启 58ms / 稳态 0.7ms。
- 实现偏差：`reconcileFs` 仅启动时跑一次；删 `ai:snapshot` / `ai:deleteRepo`（保存快照 / 删仓由 `project-write` 内部完成）。

## 本文档不包括什么

- 数据迁移：老大明确无旧数据，升级后旧 `us:script:*` 只当已弃用旧记录展示、可一键清理。
- `DL.store` / `us:errors` 纳入单写方：二者写入不受控、不参与「脚本是什么」的真相判定，故划出 SW 直写 storage。
- git 历史与草稿的 lfs 写入方：归 `notes/content/userscript-git-history.md`；本文只记「项目数据归 offscreen 单写」结论。

## 决策记录

| 决策时间 | 决策点（≤100字） | 结论（≤100字） | 依据（≤100字） |
| --- | --- | --- | --- |
| 2026-09-15 | 单写方落地 | offscreen 持有项目数据 | 一次保存同源写状态+commit，偏差面塌掉 |
| 2026-09-15 | 旧数据迁移 | 不做 | 老大明确无旧数据 |
