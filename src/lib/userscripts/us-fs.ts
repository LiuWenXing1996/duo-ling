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

// —— 整库浏览（只读调试视图，ai:lfsTree 的数据源）——

/** lfs 树节点：目录含 children，文件含 size */
export interface LfsNode {
  /** 完整路径（根为 '/'） */
  path: string
  /** 展示名 */
  name: string
  type: 'file' | 'folder'
  /** 仅文件：字节大小 */
  size?: number
  /** 仅目录 */
  children?: LfsNode[]
}

/** 节点数上限：防御性兜底，防异常状态把应答报文撑爆 */
const LFS_TREE_MAX_NODES = 10000

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : dir + '/' + name
}

/**
 * 递归列出 lfs 库的完整文件树，**offscreen-only**（lfs 单实例约束）。
 * 含 `.git` 内部结构 —— 本视图定位是整库观察 / 调试，git 对象分片是真实落盘形状，不隐藏。
 * 目录在前、按名称排序；超出节点上限直接抛错（宁可失败也不回半棵树）。
 */
export async function readLfsTree(root = '/'): Promise<LfsNode> {
  let count = 0
  async function walk(dir: string, name: string): Promise<LfsNode> {
    if (++count > LFS_TREE_MAX_NODES) {
      throw new Error(`lfs 树节点数超出上限 ${LFS_TREE_MAX_NODES}，疑似异常状态`)
    }
    const entries = await pfs.readdir(dir)
    const children: LfsNode[] = []
    for (const entry of entries) {
      const full = joinPath(dir, entry)
      const st = await pfs.stat(full)
      if (st.isDirectory()) children.push(await walk(full, entry))
      else children.push({ path: full, name: entry, type: 'file', size: st.size })
    }
    children.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1,
    )
    return { path: dir, name, type: 'folder', children }
  }
  return walk(root, 'duoling（lfs 根）')
}
