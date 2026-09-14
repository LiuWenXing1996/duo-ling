// 用户脚本文件树与 git 仓的底层文件系统（lightning-fs 单例），**offscreen-only**。
//
// 从原 lib/idb-fs.ts 搬来：lfs 实例归属从 SW 迁到 offscreen（docs/offscreen-fs-migration.md）。
// 现在全仓只有 us-git.ts 引用本文件，且 us-git 已归 offscreen，故 SW 侧不再持有 lfs 实例，
// 双实例互不可见的老问题不会复发（单写方不变量）。
//
// ⚠️ 单实例约束：lightning-fs 带内存索引层，同库多实例会互相看不见写入。
// 全仓只允许从这里取实例，不要在别处 new LightningFS。
import LightningFS from '@isomorphic-git/lightning-fs'

/** 库名沿用 'duoling'：/uscripts/<uuid>/ 与旧的 /tools/<id>/ 同库，改名会让脚本历史一起失联 */
export const fs = new LightningFS('duoling')
export const pfs = fs.promises
