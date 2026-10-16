// 用户脚本源码与 git 仓的底层文件系统（lightning-fs 单例），**offscreen-only**。
//
// 这就是「duoling-fs」库——源码的唯一权威来源（见 AGENTS.md「存储」与 userscript-core 的
// ScriptProject 注释）：每个脚本的源码文件树与 git 历史都落在 `/uscripts/<uuid>/` 下，
// 由 offscreen 独占读写；SW 与扩展页要读源码，一律经本包的服务方法取。
//
// ⚠️ 单实例约束：lightning-fs 带内存索引层，同库多实例会互相看不见写入。
// 全仓只允许从这里取实例，不要在别处 new LightningFS。
//
// 惰性初始化（不是顶层建实例）：本包声明 sideEffects:false，顶层副作用会被判成可摇掉的代码；
// 且 Node 下（无 indexedDB）import 即产生未处理 rejection —— 首访才建，两件事一起解决。
import type { LfsFileContent, LfsNode } from '@duoling/proxy-service-list'
import LightningFS from '@isomorphic-git/lightning-fs'

/** 库名 duoling-fs：源码唯一来源（与注册态库 duoling-state 分离） */
const FS_DB_NAME = 'duoling-fs'

function createFs() {
  return new LightningFS(FS_DB_NAME)
}

let instance: ReturnType<typeof createFs> | null = null

/** 取 lfs 单例（首访建实例）—— 全仓唯一的取用口 */
export function getFs(): ReturnType<typeof createFs> {
  return (instance ??= createFs())
}

/** 单例的 promise 面：各 fs 操作统一从这里取 */
export function getPfs(): ReturnType<typeof createFs>['promises'] {
  return getFs().promises
}

// —— 整库浏览（只读调试视图，fsLfsTree 的数据源）——

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
  const pfs = getPfs()
  let count = 0
  async function walk(dir: string, name: string): Promise<LfsNode> {
    if (++count > LFS_TREE_MAX_NODES) {
      throw new Error(`文件树节点数超出上限 ${LFS_TREE_MAX_NODES}，疑似异常状态`)
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
  return walk(root, '根目录')
}

// —— 单文件预览（只读调试视图，fsLfsReadFile 的数据源）——

/** 预览读取上限：防御性兜底，防止巨型文件把应答报文撑爆 / 卡死渲染 */
const LFS_READ_MAX_BYTES = 1024 * 1024

/** 二进制启发式：命中 NUL 字节即判二进制；否则按前 512 字节不可打印比例估算 */
function isBinaryContent(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false
  if (bytes.includes(0)) return true
  const sample = Math.min(bytes.length, 512)
  let nonText = 0
  for (let i = 0; i < sample; i++) {
    const b = bytes[i]
    // 允许 tab(9) / LF(10) / CR(13) / 空格及以上可打印 / UTF-8 多字节引导字节(>=128)
    if (b < 32 && b !== 9 && b !== 10 && b !== 13) nonText++
  }
  return nonText / sample > 0.1
}

/** Uint8Array → base64（分块避免 String.fromCharCode 展开超大数组爆栈） */
function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

/**
 * 按完整路径读 lfs 库内单文件内容，**offscreen-only**（lfs 单实例约束）。
 * 文本文件原样解码 utf8 返回；二进制（含 .git 对象）返回 base64 + binary 标记，
 * 图片类由 UI 用这份 base64 直接显示，其余二进制提示不可预览。
 * 超过 1MB 截断到前 1MB 并置 truncated（仍可看头部，如巨型打包文件）。
 */
export async function readLfsFile(path: string): Promise<LfsFileContent> {
  const raw = (await getPfs().readFile(path)) as Uint8Array
  const size = raw.length
  const truncated = size > LFS_READ_MAX_BYTES
  const view = truncated ? raw.subarray(0, LFS_READ_MAX_BYTES) : raw
  if (isBinaryContent(view)) {
    return { path, size, read: view.length, truncated, encoding: 'base64', binary: true, content: toBase64(view) }
  }
  const content = new TextDecoder('utf-8', { fatal: false }).decode(view)
  return { path, size, read: view.length, truncated, encoding: 'utf8', binary: false, content }
}
