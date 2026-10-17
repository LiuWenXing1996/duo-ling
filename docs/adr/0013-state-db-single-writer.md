# 0013. 状态库独立于 lfs、单写方 offscreen

日期: 2026-10-18
状态: 已接受
代码落点: packages/shared/src/state-db.ts（文件头指针指回本文件）

## 背景

用户脚本项目数据需要一个 SW / offscreen / 扩展页都能看到的存储。lightning-fs（`duoling-fs` 库）不行：它自带内存索引层，同库多实例会互相看不见写入（见 @duoling/offscreen-document 的 fs/lfs 单实例约束），SW / 扩展页根本读不到 lfs 里的内容——这也是项目数据一度只能放 chrome.storage 的根因。

## 决策

- 独立 IndexedDB 库存项目数据。裸 IndexedDB 是真正的共享存储：SW / offscreen / 扩展页打开同一个库名，看到的是同一份数据。已实测：浏览器冷启动、offscreen 尚未创建时，SW 已能读到上一轮 offscreen 写进 IDB 的内容。
- **单写方约定（本方案的核心）**：写 API 只许 offscreen 调用；SW 与扩展页只许读。这不是技术限制（技术上谁都能写），是刻意的收敛——一次保存只有一个写方，「写了状态但没 commit」「已保存但没 commit」这类偏差就没有产生的缝隙。
- 违反方式：在 offscreen 之外 import writeProject / removeProject 等。
