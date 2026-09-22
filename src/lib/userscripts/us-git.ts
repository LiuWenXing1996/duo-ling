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
import type { CommitActor } from './types'

/**
 * 改动来源的 git 身份映射：来源类型定义在 types.ts（IPC 契约也要引用，故不放实现文件里）。
 * 存进 git 的 author 字段、**不拼进 message** —— message 是给用户读的「改了什么」，
 * 来源是「谁改的」，两件事分开存，message 才不会被「AI：」这类前缀污染。
 */
const IDENTITY: Record<CommitActor, { name: string; email: string }> = {
  user: { name: 'user', email: 'user@duoling.local' },
  ai: { name: 'ai', email: 'ai@duoling.local' },
  system: { name: 'system', email: 'system@duoling.local' },
}

/** 由 git author 反解来源；认不出（来源字段引入前的老提交）按 user 处理 */
function actorFromEmail(email: string | undefined): CommitActor {
  if (email === IDENTITY.ai.email) return 'ai'
  if (email === IDENTITY.system.email) return 'system'
  return 'user'
}

const US_ROOT = '/uscripts'
const SOURCE_FILE = 'script.js'

/** 一次读取到的源码（工作区或某次提交）；单文件形态下源码本身即全部事实，无并行元数据文件 */
export interface Source {
  code: string
}

export interface UsCommit {
  oid: string
  message: string
  /** 毫秒时间戳（fs-store 的 ToolCommit 用秒，这里面向自有 UI，统一毫秒） */
  time: number
  /** 这次改动是谁做的：历史面板据此显示来源标签（user 不显示） */
  actor: CommitActor
}

/** 某提交的完整快照：单文件形态下只有源码（历史版本同样不含并行元数据文件） */
export interface UsSnapshot {
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

/**
 * 把源码写入工作区（script.js）。单文件形态下源码本身即全部事实，无并行元数据文件。
 * 不碰 .git、不动 index（提交由 commitSource 负责）。
 */
export async function writeSource(uuid: string, code: string): Promise<void> {
  assertSafeUuid(uuid)
  await ensureRepo(uuid)
  await writeRepoFile(uuid, SOURCE_FILE, code)
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
  if (code) return { code }
  // 工作区空（未保存 / 草稿已清空）→ 回退 HEAD
  const head = await headOid(uuid)
  if (!head) return null
  return snapshotToSource(uuid, head)
}

/** 读取某提交（源码） */
async function snapshotToSource(uuid: string, oid: string): Promise<Source | null> {
  const snap = await readSnapshotAt(uuid, oid)
  if (snap.code === undefined) return null
  return { code: snap.code }
}

/** 无备注时的默认版本名：「保存 2026-09-22 19:46」（本地时间；带年份，几个月后回看也读得懂） */
function defaultSaveMessage(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `保存 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 提交工作区（保存成功后调用）：script.js 与 HEAD 一致则不提交（无空提交）；
 * message = 备注优先，否则「保存 <本地时间>」—— 用时间戳而不是自增编号：编号需要可靠计数器
 * （回滚提交也占号会让它跳），时间戳天然唯一、不依赖额外状态。
 */
export async function commitSource(
  uuid: string,
  note?: string,
  actor: CommitActor = 'user',
): Promise<{ committed: boolean; oid?: string }> {
  assertSafeUuid(uuid)
  await ensureRepo(uuid)
  const dir = usDir(uuid)
  const head = await headOid(uuid)
  const code = await readWorktreeCode(uuid)
  if (code == null) return { committed: false }
  let changed = true
  if (head) {
    const headCode = await readBlobText(uuid, head, SOURCE_FILE)
    changed = code !== headCode
  }
  if (!changed) return { committed: false }

  await writeRepoFile(uuid, SOURCE_FILE, code)
  await git.add({ fs, dir, filepath: SOURCE_FILE })

  const message = note?.trim() || defaultSaveMessage(Date.now())
  const oid = await git.commit({ fs, dir, message, author: IDENTITY[actor] })
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
      actor: actorFromEmail(entry.commit.author.email),
    }))
  } catch {
    return []
  }
}

/** 读某提交的完整快照（script.js 为源码；单文件形态，无并行元数据文件） */
export async function readSnapshotAt(uuid: string, oid: string): Promise<UsSnapshot> {
  assertSafeUuid(uuid)
  const code = await readBlobText(uuid, oid, SOURCE_FILE)
  return { code }
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
  if (snap.code === undefined) throw new Error('历史版本不存在或已损坏')

  await writeSource(uuid, snap.code)
  const head = await headOid(uuid)
  if (head === oid) {
    return { committed: false, source: { code: snap.code } }
  }
  let message = `回滚到 ${oid.slice(0, 8)}`
  try {
    const { commit: target } = await git.readCommit({ fs, dir, oid })
    const original = target.message.trim()
    if (original) message = `${message}：${original}`
  } catch {
    /* 读不到原始 message 时用默认格式 */
  }
  await commitSource(uuid, message)
  return { committed: true, source: { code: snap.code } }
}
