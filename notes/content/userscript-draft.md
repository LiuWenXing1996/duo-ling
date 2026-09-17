# 编辑器草稿方案

> 一句话：草稿 = git 工作区未提交改动，自动低延迟落盘、重开静默恢复，不污染已保存语义。
> 源文档：[docs/userscript-draft.md](../../docs/userscript-draft.md)

## 现状

- 已实施（2026-09-15）：草稿 = `/uscripts/<uuid>/` 工作区未提交改动，不新建独立草稿库（评审否决独立 IDB 草稿库的三样额外负担）。
- 三处状态：已保存（IndexedDB `duoling-state`，权威）/ 已提交（HEAD）/ 草稿（工作区）；判定与回滚一律以状态库为基准，不以 HEAD（HEAD 可能落后）。
- 写工作区纯 fs 不动 index（`writeWorktree`）；打开时 `readWorktree` 判 null 防清空用户脚本；deep watch + debounce 500ms + 串行化 + 关标签前 flush。
- 保存即提交、`baseline` 更新；丢弃用 `baseline` 重写工作区（不用 `git checkout HEAD`）；恢复历史版本整体覆盖工作区 = 隐式丢弃草稿。

## 本文档不包括什么

- 独立 IndexedDB 草稿库（`draft-store.ts`）；`git checkout HEAD` 回滚（HEAD 可能落后 storage）。

## 决策记录

| 决策时间 | 决策点（≤100字） | 结论（≤100字） | 依据（≤100字） |
| --- | --- | --- | --- |
| 2026-09-14 | 草稿形态 | = 工作区未提交改动 | 复用 git 原生语义，不增表示与转换 |
| 2026-09-15 | 草稿清理 | 随单写方 `state:remove` 一步清 | 删脚本即删整目录仓，不再滞留 |
