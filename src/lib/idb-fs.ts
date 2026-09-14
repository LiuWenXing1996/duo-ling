// IndexedDB 文件系统（lightning-fs）单例 —— 共享底层，与工具链路无关。
//
// 从 fs-store.ts 抽出：工具链路（AI 生成工具页）移除后，这条底层仍被
// **用户脚本 git 历史**依赖 —— lib/userscripts/us-git.ts 用它写 /uscripts/<uuid>/ 仓。
// 抽出后 fs-store.ts 只剩工具专属函数，可随工具链路一起删掉。
//
// ⚠️ 单实例约束：lightning-fs 带内存索引层，同库多实例会互相看不见写入
// （见 docs/todo.md「模块归属规则」）。全仓只允许从这里取实例，不要在别处 new LightningFS。
import LightningFS from '@isomorphic-git/lightning-fs'

/** 库名沿用 'duoling'：/uscripts/<uuid>/ 与旧的 /tools/<id>/ 同库，改名会让脚本历史一起失联 */
export const fs = new LightningFS('duoling')
export const pfs = fs.promises
