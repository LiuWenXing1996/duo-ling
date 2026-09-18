# 脚本文件树迁 offscreen

> 一句话：lfs 与 git 仓的归属从 SW 迁到 offscreen（2026-09-14 已实施）。

## 现状

- 已实施（2026-09-14）：`us-fs.ts` 落地、`idb-fs.ts` 删除，SW 不再持有 lfs 实例。前提：工具链路已移除（lfs 的 `duoling` 库只剩 `/uscripts/*`）。
- 迁移后文件树与 git 快照归 offscreen；注册 / 脚本记录 / `DL.store` / 模型配置仍在 SW 或 `chrome.storage.local`。
- ⚠️ 2026-09-15 起 §2.3–2.5 命令面已被单写方方案取代：`ai:snapshot` / `ai:deleteRepo` 已从协议删除，`reconcileFs` 仅启动时跑一次。
- 无需迁移数据：库名 `duoling`、`/uscripts/*` 原地不动，只换读写方。

## 本文档不包括什么

- 拆独立 lfs 库 / 迁移 `/uscripts/*`：工具移除后 `duoling` 库已为脚本专用，无需拆库或迁数据。
- SW 再持有 fs 实例：lfs 内存索引层只许一个写入方，offscreen 已是唯一那一个。

## 决策记录

| 决策时间 | 决策点 | 结论 | 依据 |
| --- | --- | --- | --- |
| 2026-09-14 | lfs 归属 | 迁 offscreen（工具已移除） | 写入方从 SW 换 offscreen，仍是唯一一个 |
