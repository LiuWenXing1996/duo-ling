// 用户脚本 git 历史侧车（方案 docs/userscript-git-history.md）。
//
// 每脚本一个 isomorphic-git 仓（/uscripts/<uuid>/，lightning-fs 实例来自 lib/idb-fs）。
// storage 为权威、git 为历史：保存成功后快照写穿（bundle 不入库，恢复后由 UI 页重建）；
// 仓损坏只丢历史不丢脚本，所有失败都不阻断保存主链路。
//
// 提交 = 全量写工作区 + add + commit；恢复 = 整树物化 + 产生「回滚到 <oid>」新提交，
// 绝不 reset（历史不可变，回错可再回）。
import git from 'isomorphic-git'
import { fs, pfs } from './us-fs'
import type { ScriptConfig, ScriptProject } from './types'

const AUTHOR = { name: 'duoling', email: 'dev@duoling.local' }
const US_ROOT = '/uscripts'
const META_FILE = 'project.json'
const FILES_DIR = 'files/'

export interface UsCommit {
  oid: string
  message: string
  /** 毫秒时间戳（fs-store 的 ToolCommit 用秒，这里面向自有 UI，统一毫秒） */
  time: number
}

/** 某提交的完整快照：当时的项目元信息 + 源码文件树（project.json 已剥离） */
export interface UsHistoryTree {
  meta?: { name: string; config: ScriptConfig; entry: string }
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

/** 删除脚本的整棵 git 仓（历史不保留——2026-09-14 拍板：删脚本即删历史） */
export async function deleteRepo(uuid: string): Promise<void> {
  assertSafeUuid(uuid)
  try {
    await removeRecursive(usDir(uuid))
  } catch {
    /* 目录不存在视为已删除 */
  }
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

/**
 * 快照内容（确定性序列化，逐字节比对 HEAD）：project.json 不含 enabled / updatedAt /
 * bundle——启用态与派生产物不应制造「假变更」，恢复时 enabled 保持当前值。
 */
function buildContents(project: ScriptProject): Record<string, string> {
  const contents: Record<string, string> = {
    [META_FILE]: JSON.stringify(
      {
        v: project.v,
        uuid: project.uuid,
        name: project.name,
        config: project.config,
        entry: project.entry,
        createdAt: project.createdAt,
      },
      null,
      2,
    ),
  }
  for (const [path, src] of Object.entries(project.files)) {
    contents[FILES_DIR + path] = src
  }
  return contents
}

/** 把工作区同步成 contents 的形状：目标没有的文件从 index/工作区移除，其余写入并 add */
async function syncWorktree(uuid: string, contents: Record<string, string>): Promise<void> {
  const dir = usDir(uuid)
  const head = await listTreeFiles(uuid, 'HEAD')
  for (const filepath of head) {
    if (!(filepath in contents)) {
      await git.remove({ fs, dir, filepath }).catch(() => {})
    }
  }
  for (const [filepath, content] of Object.entries(contents)) {
    await writeRepoFile(uuid, filepath, content)
    await git.add({ fs, dir, filepath })
  }
}

/**
 * 快照（保存成功后调用）：内容与 HEAD 逐字节一致则不提交（无空提交）；
 * message = 备注优先，否则自动计数「保存 #n」（2026-09-14 拍板）。
 */
export async function snapshotProject(
  project: ScriptProject,
  note?: string,
): Promise<{ committed: boolean; oid?: string }> {
  await ensureRepo(project.uuid)
  const dir = usDir(project.uuid)
  const contents = buildContents(project)
  const headFiles = await listTreeFiles(project.uuid, 'HEAD')
  const paths = Object.keys(contents)
  // 与 HEAD 逐字节比对：文件集合一致且每个 blob 内容相同才算无变更
  let changed = headFiles.length !== paths.length
  if (!changed) {
    for (const p of paths) {
      if (!headFiles.includes(p) || (await readBlobText(project.uuid, 'HEAD', p)) !== contents[p]) {
        changed = true
        break
      }
    }
  }
  if (!changed) return { committed: false }

  await syncWorktree(project.uuid, contents)
  // 空仓（首提前）git.log 会抛 NotFoundError（Could not find refs/heads/main），按 0 计
  const count = await listHistory(project.uuid).then((l) => l.length)
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
        const parsed = JSON.parse(content) as { name?: string; config?: ScriptConfig; entry?: string }
        if (parsed.name && parsed.config) {
          meta = { name: parsed.name, config: parsed.config, entry: parsed.entry ?? 'main.js' }
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
 * 恢复到指定提交：由快照物化出 ScriptProject（bundle 丢弃、enabled 保持当前值、updatedAt 刷新），
 * 调用方负责 storage 落盘 + 重注册。仓侧：目标即 HEAD 则不产生新提交，
 * 否则整树物化工作区并提交「回滚到 <shortOid>：<原 message>」（历史不可变）。
 */
export async function restoreToCommit(
  project: ScriptProject,
  oid: string,
): Promise<{ committed: boolean; restored: ScriptProject }> {
  await ensureRepo(project.uuid)
  const dir = usDir(project.uuid)
  const paths = await listTreeFiles(project.uuid, oid)
  if (!paths.length) throw new Error('历史版本不存在或已损坏')

  // 物化项目
  let meta: UsHistoryTree['meta']
  const files: Record<string, string> = {}
  for (const p of paths) {
    const content = await readBlobText(project.uuid, oid, p)
    if (content === undefined) continue
    if (p === META_FILE) {
      try {
        const parsed = JSON.parse(content) as { name?: string; config?: ScriptConfig; entry?: string }
        if (parsed.name && parsed.config) meta = { name: parsed.name, config: parsed.config, entry: parsed.entry ?? 'main.js' }
      } catch {
        /* 用当前项目元信息兜底 */
      }
      continue
    }
    if (p.startsWith(FILES_DIR)) files[p.slice(FILES_DIR.length)] = content
  }
  if (!Object.keys(files).length) throw new Error('该版本没有可恢复的源码文件')
  const head = await headOid(project.uuid)
  const restored: ScriptProject = {
    ...project,
    name: meta?.name ?? project.name,
    config: meta?.config ?? project.config,
    entry: meta?.entry ?? project.entry,
    files,
    bundle: undefined,
    updatedAt: Date.now(),
  }

  if (head === oid) return { committed: false, restored }

  // 工作区整树物化（含 project.json 原样）并提交——绝不 reset
  const contents: Record<string, string> = {}
  for (const p of paths) {
    const c = await readBlobText(project.uuid, oid, p)
    if (c !== undefined) contents[p] = c
  }
  await syncWorktree(project.uuid, contents)
  let message = `回滚到 ${oid.slice(0, 8)}`
  try {
    const { commit: target } = await git.readCommit({ fs, dir, oid })
    const original = target.message.trim()
    if (original) message = `${message}：${original}`
  } catch {
    /* 读不到原始 message 时用默认格式 */
  }
  await git.commit({ fs, dir, message, author: AUTHOR })
  return { committed: true, restored }
}
