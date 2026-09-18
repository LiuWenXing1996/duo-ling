// 用户脚本源码与 git 版本化：每脚本一仓，源码的唯一权威来源落在 duoling-fs（us-fs）。
//
// 设计（2026-09-19 重构）：源码不再进状态库（duoling-state 退化成「注册态库」，只存
// bundle + 元数据）。这里就是源码的落点——
//   · 工作区（/uscripts/<uuid>/files/**）= 当前源码，天然承载「未保存改动」；
//   · 提交（git commit）= 一次保存 / 导入 / 恢复产生的历史版本；
//   · 读源码一律走这里（offscreen 内直读，或经 fs:* 命令对外）。
//
// 单写方：本文件只被 offscreen 调用（project-write / offscreen-fs-commands），仓损坏只丢
// 历史不丢脚本，所有失败都不阻断保存主链路。
import git from 'isomorphic-git'
import { fs, pfs } from './us-fs'
import type { ScriptConfig, ScriptMeta } from './types'

const AUTHOR = { name: 'duoling', email: 'dev@duoling.local' }
const US_ROOT = '/uscripts'
const META_FILE = 'project.json'
const FILES_DIR = 'files/'

/** 一次读取到的源码树（工作区或某次提交） */
export interface SourceTree {
  meta: ScriptMeta
  files: Record<string, string>
}

export interface UsCommit {
  oid: string
  message: string
  /** 毫秒时间戳（fs-store 的 ToolCommit 用秒，这里面向自有 UI，统一毫秒） */
  time: number
}

/** 某提交的完整快照：当时的项目元信息 + 源码文件树（project.json 已剥离） */
export interface UsHistoryTree {
  meta?: ScriptMeta
  files: Array<{ path: string; content: string }>
}

/** uuid 来自 UI/消息层，防路径穿越（对齐 fs-store assertSafeToolId） */
function assertSafeUuid(uuid: unknown): asserts uuid is string {
  if (
    typeof uuid !== 'string' ||
    !uuid ||
    uuid.includes('..') ||
    uuid.includes('/') ||
    uuid.includes('\\')
  ) {
    throw new Error('非法脚本 id')
  }
}

const usDir = (uuid: string): string => `${US_ROOT}/${uuid}`

/** 递归建目录（幂等）；lightning-fs 的 mkdir 不递归、已存在会抛错 */
async function ensureDir(dir: string): Promise<void> {
  if (!dir) return
  try {
    await pfs.stat(dir)
    return
  } catch {
    /* 不存在，继续建 */
  }
  const parent = dir.slice(0, dir.lastIndexOf('/'))
  if (parent) await ensureDir(parent)
  try {
    await pfs.mkdir(dir)
  } catch {
    /* 并发或已存在 */
  }
}

async function writeRepoFile(uuid: string, rel: string, content: string): Promise<void> {
  const abs = `${usDir(uuid)}/${rel}`
  await ensureDir(abs.slice(0, abs.lastIndexOf('/')))
  await pfs.writeFile(abs, content)
}

async function removeRecursive(path: string): Promise<void> {
  const st = await pfs.stat(path)
  if (st.type === 'dir') {
    const entries = (await pfs.readdir(path)) as string[]
    for (const name of entries) await removeRecursive(`${path}/${name}`)
    await pfs.rmdir(path)
  } else {
    await pfs.unlink(path)
  }
}

export async function ensureRepo(uuid: string): Promise<void> {
  assertSafeUuid(uuid)
  await ensureDir(usDir(uuid))
  try {
    await git.init({ fs, dir: usDir(uuid), defaultBranch: 'main' })
  } catch {
    /* 已 init 则忽略 */
  }
}

/** 删除脚本的整棵 git 仓（历史不保留：删脚本即删历史） */
export async function deleteRepo(uuid: string): Promise<void> {
  assertSafeUuid(uuid)
  try {
    await removeRecursive(usDir(uuid))
  } catch {
    /* 目录不存在视为已删除 */
  }
}

/** 删除 /uscripts 下的**全部**仓目录（删除全部脚本时的收尾） */
export async function deleteAllRepos(): Promise<number> {
  let entries: string[] = []
  try {
    entries = (await pfs.readdir(US_ROOT)) as string[]
  } catch {
    return 0 // 根目录不存在 = 本来就没有仓
  }
  for (const uuid of entries) {
    await deleteRepo(uuid).catch(() => {})
  }
  return entries.length
}

/** HEAD 提交 oid（无任何提交时 undefined） */
async function headOid(uuid: string): Promise<string | undefined> {
  try {
    return await git.resolveRef({ fs, dir: usDir(uuid), ref: 'HEAD' })
  } catch {
    return undefined
  }
}

/** 目标提交树中全部 blob 的相对路径（无仓 / 无该提交时返回空） */
async function listTreeFiles(uuid: string, oid: string): Promise<string[]> {
  const files: string[] = []
  try {
    await git.walk({
      fs,
      dir: usDir(uuid),
      trees: [git.TREE({ ref: oid })],
      map: async (filepath, [entry]) => {
        if (!entry) return
        if ((await entry.type()) === 'blob') files.push(filepath)
      },
    })
  } catch {
    return []
  }
  return files
}

async function readBlobText(uuid: string, oid: string, filepath: string): Promise<string | undefined> {
  try {
    const { blob } = await git.readBlob({ fs, dir: usDir(uuid), oid, filepath })
    return new TextDecoder().decode(blob)
  } catch {
    return undefined
  }
}

/** project.json 的序列化内容（不含 files——files 单独物化进 files/） */
function metaJson(meta: ScriptMeta, uuid: string): string {
  return JSON.stringify(
    { v: 1, uuid, name: meta.name, config: meta.config, entry: meta.entry, createdAt: meta.createdAt },
    null,
    2,
  )
}

/**
 * 把源码文件树写入工作区（files/**）+ 写 project.json 元数据（不含 files）。
 * 整体清空旧 files/ 后重写——保证删文件也生效；project.json 最后写，
 * 作为「这批源码写完了」的提交点（半写保护）。不碰 .git、不动 index。
 */
export async function writeSourceTree(
  uuid: string,
  files: Record<string, string>,
  meta: ScriptMeta,
): Promise<void> {
  assertSafeUuid(uuid)
  await ensureRepo(uuid)
  try {
    await removeRecursive(`${usDir(uuid)}/${FILES_DIR}`)
  } catch {
    /* files/ 不存在，视为已清空 */
  }
  for (const [rel, content] of Object.entries(files)) {
    await writeRepoFile(uuid, FILES_DIR + rel, content)
  }
  await writeRepoFile(uuid, META_FILE, metaJson(meta, uuid))
}

/** 读工作区 files/ 全部文件（相对路径 → 源码）；目录不存在返回 null */
async function readWorktreeFiles(uuid: string): Promise<Record<string, string> | null> {
  const files: Record<string, string> = {}
  try {
    const walk = async (dir: string, rel: string): Promise<void> => {
      const entries = (await pfs.readdir(dir)) as string[]
      for (const name of entries) {
        const abs = `${dir}/${name}`
        const st = await pfs.stat(abs)
        const relPath = rel ? `${rel}/${name}` : name
        if (st.type === 'dir') await walk(abs, relPath)
        else files[relPath] = new TextDecoder().decode(await pfs.readFile(abs))
      }
    }
    await walk(`${usDir(uuid)}/${FILES_DIR}`, '')
  } catch {
    return null
  }
  return Object.keys(files).length ? files : null
}

/** 读工作区 project.json 的元数据；读不出返回 null */
async function readWorktreeMeta(uuid: string): Promise<ScriptMeta | null> {
  let raw: string
  try {
    raw = new TextDecoder().decode(await pfs.readFile(`${usDir(uuid)}/${META_FILE}`))
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { name?: string; config?: ScriptConfig; entry?: string; createdAt?: number }
    if (!parsed.name || !parsed.config) return null
    return {
      name: parsed.name,
      config: parsed.config,
      entry: parsed.entry ?? 'main.js',
      createdAt: parsed.createdAt ?? 0,
    }
  } catch {
    return null
  }
}

/**
 * 读当前源码树。committed=false（默认）= 工作区（含未保存改动），
 * 工作区为空时回退到 HEAD；committed=true = HEAD 提交（已保存版本，丢弃草稿用）。
 * 无源码（仓损坏 / 从未保存）返回 null。
 */
export async function readSourceTree(uuid: string, committed = false): Promise<SourceTree | null> {
  assertSafeUuid(uuid)
  if (committed) {
    const head = await headOid(uuid)
    if (!head) return null
    return treeAt(uuid, head)
  }
  const files = await readWorktreeFiles(uuid)
  const meta = await readWorktreeMeta(uuid)
  if (files && meta) return { meta, files }
  // 工作区空（未保存 / 草稿已清空）→ 回退 HEAD
  const head = await headOid(uuid)
  if (!head) return null
  return treeAt(uuid, head)
}

/** 读取某提交树（含元数据） */
async function treeAt(uuid: string, oid: string): Promise<SourceTree | null> {
  const tree = await readTreeAt(uuid, oid)
  if (!tree.files.length || !tree.meta) return null
  const files: Record<string, string> = {}
  for (const f of tree.files) files[f.path] = f.content
  return { meta: tree.meta, files }
}

/**
 * 提交工作区（保存成功后调用）：内容与 HEAD 逐字节一致则不提交（无空提交）；
 * message = 备注优先，否则自动计数「保存 #n」。
 */
export async function commitSource(
  uuid: string,
  meta: ScriptMeta,
  note?: string,
): Promise<{ committed: boolean; oid?: string }> {
  assertSafeUuid(uuid)
  await ensureRepo(uuid)
  const dir = usDir(uuid)
  const head = await headOid(uuid)
  // 比对工作区与 HEAD：先比文件集合，再比内容
  const worktree = await readWorktreeFiles(uuid)
  if (!worktree) return { committed: false }
  const headFiles = head ? await listTreeFiles(uuid, head) : []
  const workPaths = Object.keys(worktree).map((p) => FILES_DIR + p).sort()
  const headPaths = headFiles.slice().sort()
  let changed = workPaths.length !== headPaths.length
  if (!changed) {
    for (let i = 0; i < workPaths.length; i++) {
      if (workPaths[i] !== headPaths[i]) {
        changed = true
        break
      }
      const content = worktree[workPaths[i]!.slice(FILES_DIR.length)]!
      const headContent = await readBlobText(uuid, head!, workPaths[i]!)
      if (content !== headContent) {
        changed = true
        break
      }
    }
  }
  if (!changed) return { committed: false }

  // 同步 index：HEAD 有而工作区没有的条目必须从 index 移除（否则被删文件随提交复活）；
  // project.json 由下面重写覆盖，不用移除
  for (const filepath of headFiles) {
    const stillThere = filepath.startsWith(FILES_DIR) && filepath.slice(FILES_DIR.length) in worktree
    if (!stillThere && filepath !== META_FILE) {
      await git.remove({ fs, dir, filepath }).catch(() => {})
    }
  }
  for (const [rel, content] of Object.entries(worktree)) {
    await writeRepoFile(uuid, FILES_DIR + rel, content)
    await git.add({ fs, dir, filepath: FILES_DIR + rel })
  }
  await writeRepoFile(uuid, META_FILE, metaJson(meta, uuid))
  await git.add({ fs, dir, filepath: META_FILE })

  const count = (await listHistory(uuid)).length
  const message = note?.trim() || `保存 #${count + 1}`
  const oid = await git.commit({ fs, dir, message, author: AUTHOR })
  return { committed: true, oid }
}

/** 历史列表（新提交在前；无仓 / 无提交返回空数组） */
export async function listHistory(uuid: string): Promise<UsCommit[]> {
  assertSafeUuid(uuid)
  try {
    const log = await git.log({ fs, dir: usDir(uuid) })
    return log.map((entry) => ({
      oid: entry.oid,
      message: entry.commit.message.trim(),
      time: entry.commit.author.timestamp * 1000,
    }))
  } catch {
    return []
  }
}

/** 读某提交的完整快照（project.json 解出元信息；files/ 前缀剥离为项目相对路径） */
export async function readTreeAt(uuid: string, oid: string): Promise<UsHistoryTree> {
  assertSafeUuid(uuid)
  const paths = await listTreeFiles(uuid, oid)
  const files: UsHistoryTree['files'] = []
  let meta: UsHistoryTree['meta']
  for (const p of paths) {
    const content = await readBlobText(uuid, oid, p)
    if (content === undefined) continue
    if (p === META_FILE) {
      try {
        const parsed = JSON.parse(content) as { name?: string; config?: ScriptConfig; entry?: string; createdAt?: number }
        if (parsed.name && parsed.config) {
          meta = {
            name: parsed.name,
            config: parsed.config,
            entry: parsed.entry ?? 'main.js',
            createdAt: parsed.createdAt ?? 0,
          }
        }
      } catch {
        /* 元信息损坏时只展示文件 */
      }
      continue
    }
    if (p.startsWith(FILES_DIR)) {
      files.push({ path: p.slice(FILES_DIR.length), content })
    }
  }
  return { meta, files }
}

/**
 * 恢复到指定提交：把目标树物化回工作区（= 当前源码）+ 提交一条「回滚」记录。
 * 返回恢复出的源码树，由调用方负责构建 + 经 updateFiles 落盘（写状态库 + 重注册）。
 * 仓侧：目标即 HEAD 则不产生新提交，否则整树物化工作区并提交——绝不 reset（历史不可变）。
 */
export async function restoreToCommit(
  uuid: string,
  oid: string,
): Promise<{ committed: boolean; tree: SourceTree }> {
  assertSafeUuid(uuid)
  await ensureRepo(uuid)
  const dir = usDir(uuid)
  const tree = await readTreeAt(uuid, oid)
  if (!tree.files.length || !tree.meta) throw new Error('历史版本不存在或已损坏')
  const files: Record<string, string> = {}
  for (const f of tree.files) files[f.path] = f.content

  await writeSourceTree(uuid, files, tree.meta)
  const head = await headOid(uuid)
  if (head === oid) {
    return { committed: false, tree: { meta: tree.meta, files } }
  }
  let message = `回滚到 ${oid.slice(0, 8)}`
  try {
    const { commit: target } = await git.readCommit({ fs, dir, oid })
    const original = target.message.trim()
    if (original) message = `${message}：${original}`
  } catch {
    /* 读不到原始 message 时用默认格式 */
  }
  await commitSource(uuid, tree.meta, message)
  return { committed: true, tree: { meta: tree.meta, files } }
}
