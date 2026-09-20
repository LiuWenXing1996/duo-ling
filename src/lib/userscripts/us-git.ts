// 用户脚本源码与 git 版本化：每脚本一仓，源码的唯一权威来源落在 duoling-fs（us-fs）。
//
// 设计（2026-09-20 单文件化重构）：源码不再进状态库（duoling-state 退化成「注册态库」，只存
// 元数据 + 源码搬运副本）。这里就是源码的落点——
//   · 工作区（/uscripts/<uuid>/script.js）= 当前源码，天然承载「未保存改动」；
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
const SOURCE_FILE = 'script.js'

/** 一次读取到的源码（工作区或某次提交） */
export interface Source {
  meta: ScriptMeta
  code: string
}

export interface UsCommit {
  oid: string
  message: string
  /** 毫秒时间戳（fs-store 的 ToolCommit 用秒，这里面向自有 UI，统一毫秒） */
  time: number
}

/** 某提交的完整快照：当时的元信息 + 源码（project.json 已剥离） */
export interface UsSnapshot {
  meta?: ScriptMeta
  code?: string
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

async function readBlobText(uuid: string, oid: string, filepath: string): Promise<string | undefined> {
  try {
    const { blob } = await git.readBlob({ fs, dir: usDir(uuid), oid, filepath })
    return new TextDecoder().decode(blob)
  } catch {
    return undefined
  }
}

/** project.json 的序列化内容（源码单独物化进 script.js） */
function metaJson(meta: ScriptMeta, uuid: string): string {
  return JSON.stringify(
    { v: 2, uuid, name: meta.name, config: meta.config, createdAt: meta.createdAt },
    null,
    2,
  )
}

/** 解析 project.json 文本；缺关键字段返回 null */
function parseMetaJson(raw: string): ScriptMeta | null {
  try {
    const parsed = JSON.parse(raw) as { name?: string; config?: ScriptConfig; createdAt?: number }
    if (!parsed.name || !parsed.config) return null
    return {
      name: parsed.name,
      config: parsed.config,
      createdAt: parsed.createdAt ?? 0,
    }
  } catch {
    return null
  }
}

/**
 * 把源码写入工作区（script.js）+ 写 project.json 元数据。
 * project.json 最后写，作为「这批源码写完了」的提交点（半写保护）。不碰 .git、不动 index。
 */
export async function writeSource(uuid: string, code: string, meta: ScriptMeta): Promise<void> {
  assertSafeUuid(uuid)
  await ensureRepo(uuid)
  await writeRepoFile(uuid, SOURCE_FILE, code)
  await writeRepoFile(uuid, META_FILE, metaJson(meta, uuid))
}

/** 读工作区 script.js 源码；不存在返回 null */
async function readWorktreeCode(uuid: string): Promise<string | null> {
  try {
    const raw = await pfs.readFile(`${usDir(uuid)}/${SOURCE_FILE}`)
    const text = new TextDecoder().decode(raw)
    return text.length ? text : null
  } catch {
    return null
  }
}

/** 读工作区 project.json 的元数据；读不出返回 null */
async function readWorktreeMeta(uuid: string): Promise<ScriptMeta | null> {
  try {
    const raw = new TextDecoder().decode(await pfs.readFile(`${usDir(uuid)}/${META_FILE}`))
    return parseMetaJson(raw)
  } catch {
    return null
  }
}

/**
 * 读当前源码。committed=false（默认）= 工作区（含未保存改动），
 * 工作区为空时回退到 HEAD；committed=true = HEAD 提交（已保存版本，丢弃草稿用）。
 * 无源码（仓损坏 / 从未保存）返回 null。
 */
export async function readSource(uuid: string, committed = false): Promise<Source | null> {
  assertSafeUuid(uuid)
  if (committed) {
    const head = await headOid(uuid)
    if (!head) return null
    return snapshotToSource(uuid, head)
  }
  const code = await readWorktreeCode(uuid)
  const meta = await readWorktreeMeta(uuid)
  if (code && meta) return { meta, code }
  // 工作区空（未保存 / 草稿已清空）→ 回退 HEAD
  const head = await headOid(uuid)
  if (!head) return null
  return snapshotToSource(uuid, head)
}

/** 读取某提交（含元数据） */
async function snapshotToSource(uuid: string, oid: string): Promise<Source | null> {
  const snap = await readSnapshotAt(uuid, oid)
  if (snap.code === undefined || !snap.meta) return null
  return { meta: snap.meta, code: snap.code }
}

/**
 * 提交工作区（保存成功后调用）：script.js 与 project.json 都与 HEAD 一致则不提交（无空提交）；
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
  // 比对工作区与 HEAD：源码与元数据任一不同即需要提交（改名 / 改配置也是一次保存）
  const code = await readWorktreeCode(uuid)
  if (code == null) return { committed: false }
  let changed = true
  if (head) {
    const headCode = await readBlobText(uuid, head, SOURCE_FILE)
    const headMetaRaw = await readBlobText(uuid, head, META_FILE)
    changed = code !== headCode || metaJson(meta, uuid) !== headMetaRaw
  }
  if (!changed) return { committed: false }

  await writeRepoFile(uuid, SOURCE_FILE, code)
  await git.add({ fs, dir, filepath: SOURCE_FILE })
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

/** 读某提交的完整快照（project.json 解出元信息；script.js 为源码） */
export async function readSnapshotAt(uuid: string, oid: string): Promise<UsSnapshot> {
  assertSafeUuid(uuid)
  const code = await readBlobText(uuid, oid, SOURCE_FILE)
  const metaRaw = await readBlobText(uuid, oid, META_FILE)
  return {
    code,
    ...(metaRaw !== undefined ? { meta: parseMetaJson(metaRaw) ?? undefined } : {}),
  }
}

/**
 * 恢复到指定提交：把目标快照物化回工作区（= 当前源码）+ 提交一条「回滚」记录。
 * 返回恢复出的源码，由调用方负责经 userscript:save 落盘（写状态库 + 重注册）。
 * 仓侧：目标即 HEAD 则不产生新提交，否则物化工作区并提交——绝不 reset（历史不可变）。
 */
export async function restoreToCommit(
  uuid: string,
  oid: string,
): Promise<{ committed: boolean; source: Source }> {
  assertSafeUuid(uuid)
  await ensureRepo(uuid)
  const dir = usDir(uuid)
  const snap = await readSnapshotAt(uuid, oid)
  if (snap.code === undefined || !snap.meta) throw new Error('历史版本不存在或已损坏')

  await writeSource(uuid, snap.code, snap.meta)
  const head = await headOid(uuid)
  if (head === oid) {
    return { committed: false, source: { meta: snap.meta, code: snap.code } }
  }
  let message = `回滚到 ${oid.slice(0, 8)}`
  try {
    const { commit: target } = await git.readCommit({ fs, dir, oid })
    const original = target.message.trim()
    if (original) message = `${message}：${original}`
  } catch {
    /* 读不到原始 message 时用默认格式 */
  }
  await commitSource(uuid, snap.meta, message)
  return { committed: true, source: { meta: snap.meta, code: snap.code } }
}
