# 0015. 观测库索引：复合键换精确查询与增量续拉

日期: 2026-10-18
状态: 已接受
代码落点: packages/service-worker/src/userscripts/runtime-db.ts（by_kind_run）与 packages/shared/src/db/runtime.ts（by_session_seq），两处指回本文件

## 决策 1：`by_kind_run = [kind, runId]` 复合索引

合表后运行条与它的动作行、错误行共用 `runId`。单键 `runId` 索引下「按 runId 找那条运行条」只能 `getAll` 把整次运行的**上千条动作**一起读回来——每追加一条动作都要付这份代价，一次 1000 动作的运行就是 O(n²)（真实 IndexedDB 里能跑但白烧，fake-indexeddb 下直接超时）。带上 `kind` 后，找运行条是 `['run', runId]` 精确一击（O(log n)），拉动作是 `['act', runId]`，两边互不串。

行不带 `runId`（文档事件、接口采样、无归属错误）时复合键含 `undefined` → **不进索引**，与「按 runId 反查只该命中运行 / 动作 / 挂上运行条的错误」正好同向。

## 决策 2：`by_session_seq = [tabSessionId, id]`（id 是表主键自增号 = 落盘序）

面板要**增量**续拉新落盘的行，而增量只能在索引键上做范围裁剪（下界 `[本页, 上次最大 id + 1]`）。单键索引做不到，只能把整根轴读回来再筛——轴不设上限、录得越久越长，那样每次「增量」都要付一次全量的读代价。

前缀查询与原用途完全等价（按页取全部 / 按页级联删除），且天然按落盘序排。
