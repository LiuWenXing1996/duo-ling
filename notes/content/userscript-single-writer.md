# 脚本存储单写方

> 一句话：项目数据（源码/配置/产物）迁 offscreen 单写，统一进独立 IndexedDB 库 `duoling-state`。
> 源文档：[docs/userscript-single-writer.md](../../docs/userscript-single-writer.md)

## 现状

- 已实现（2026-09-15）：项目数据迁出 `chrome.storage`，改存 offscreen 持有的独立 IDB 库 `duoling-state`（schema v1）。
- SW 直读该库做全量注册（不经 offscreen）；写全部经 offscreen（单写方）；UI 读直读、写经 offscreen。
- 划出：`DL.store` 值、`us:errors` 仍由 SW 直写 storage（写入不受控、不参与「脚本是什么」的真相判定）。
- 前置项实测通过：SW 冷启动可读 IDB；清浏览数据两边抗清理一致；`offscreen:ensure` 冷启 58ms / 稳态 0.7ms。
- 实现偏差：新增 `state:*` 命令面；`reconcileFs` 仅启动跑一次；删 `ai:snapshot`/`ai:deleteRepo`。

## 本文档不包括什么

- 数据迁移（老大明确无旧数据）。
- `DL.store` / `us:errors` 纳入单写方。

## 决策记录

| 决策时间 | 决策点 | 结论 | 依据（一句） |
| --- | --- | --- | --- |
| 2026-09-15 | 单写方落地 | offscreen 持有项目数据 | 一次保存同源写状态+commit，偏差面塌掉 |
| 2026-09-15 | 旧数据迁移 | 不做 | 老大明确无旧数据 |
