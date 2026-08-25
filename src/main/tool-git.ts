// 主进程侧：用 isomorphic-git 为「每个工具目录」建仓，自动记录每次文件变更。
//
// A 档（本轮）：只在创建 / 变更清单成功落盘后自动 commit，暂不做界面。
// 仓库位置：<userData>/tools/<id>/.git —— 与工具本身同目录，删除工具即连同历史删除。
// 策略：一次「成功应用的变更清单」= 一个 commit（message 用变更清单 summary）；
//       应用后若无净变更则跳过提交，避免空提交。

import git from 'isomorphic-git'
import fs from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { toolsRoot, previewRoot } from './tool-page'

/** 允许纳入版本控制的工具内文件（与 tool-page.ts 的白名单一致） */
const TOOL_FILES = ['index.html', 'meta.json'] as const

/** commit 占位身份：git 要求每次提交都有合法 name/email，全空会被拒；后续可做成可配置 */
const GIT_AUTHOR = { name: 'duo-ling', email: 'duo-ling@local' }

function toolDir(id: string): string {
  return join(toolsRoot(), id)
}

/** 仓库尚不存在时 init（幂等），返回工具目录 */
async function ensureRepo(id: string): Promise<string> {
  const dir = toolDir(id)
  if (!fs.existsSync(join(dir, '.git'))) {
    await git.init({ fs, dir })
  }
  return dir
}

/** 暂存白名单文件并提交，返回 commit oid */
async function commitSnapshot(dir: string, message: string): Promise<string> {
  await git.add({ fs, dir, filepath: [...TOOL_FILES] })
  return git.commit({ fs, dir, message, author: GIT_AUTHOR })
}

/** 工具目录相对上次提交是否有净变更（用于跳过空提交） */
async function hasToolChanges(dir: string): Promise<boolean> {
  let headExists = true
  try {
    await git.resolveRef({ fs, dir, ref: 'HEAD' })
  } catch {
    headExists = false
  }
  // 仓库尚无任何提交（如旧工具首次被改）：视为有变更，走首提
  if (!headExists) return true
  const statuses = await Promise.all(TOOL_FILES.map((f) => git.status({ fs, dir, filepath: f })))
  return statuses.some((s) => s !== 'unmodified')
}

/**
 * 工具创建后调用：保证仓库存在，并做「创建工具」初始提交。
 * 仅当仓库尚无提交时才会产生首提，已存在则不做任何事（幂等）。
 */
export async function initToolRepo(
  id: string
): Promise<{ ok: true; committed: boolean } | { ok: false; error: string }> {
  try {
    const dir = await ensureRepo(id)
    if (await hasToolChanges(dir)) {
      await commitSnapshot(dir, '创建工具')
      return { ok: true, committed: true }
    }
    return { ok: true, committed: false }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 工具变更清单成功落盘后调用：若有净变更则提交，message 用变更清单的 summary。
 * 无净变更则跳过；commit 失败只返回错误，不影响改动已落盘的结果。
 */
export async function commitToolChanges(
  id: string,
  summary: string
): Promise<{ ok: true; committed: boolean; oid?: string } | { ok: false; error: string }> {
  try {
    const dir = await ensureRepo(id)
    if (!(await hasToolChanges(dir))) {
      return { ok: true, committed: false }
    }
    const oid = await commitSnapshot(dir, summary?.trim() ? summary.trim() : '更新工具')
    return { ok: true, committed: true, oid }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 一次提交的快照（新提交在前） */
export interface ToolCommit {
  oid: string
  message: string
  author: string
  timestamp: number
}

/**
 * 读取某工具的 git 提交历史（新提交在前，供「版本历史」标签页展示）。
 * 仓库尚不存在时返回空列表（正常情况，不视为错误）。
 */
export async function listToolHistory(
  id: string
): Promise<{ ok: true; commits: ToolCommit[] } | { ok: false; error: string }> {
  try {
    const dir = toolDir(id)
    if (!fs.existsSync(join(dir, '.git'))) {
      return { ok: true, commits: [] }
    }
    const logs = await git.log({ fs, dir })
    return {
      ok: true,
      commits: logs.map((c) => ({
        oid: c.oid,
        // isomorphic-git 给 commit message 末尾追加了换行，展示前 trim 掉
        message: c.commit.message.trim(),
        author: `${c.commit.author.name} <${c.commit.author.email}>`,
        timestamp: c.commit.author.timestamp
      }))
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 把目标 commit 的整棵树物化到预览缓存目录 <tools-preview>/<id>/<oid>/，供独立 `tool-preview://` 协议渲染。
 * - 遍历该 commit 下全部文件（含 index.html 引用的 ESM 子模块），而非仅白名单，规避「?oid 随子请求丢失」问题。
 * - 幂等复用：目标目录已物化（存在 index.html）时直接复用，不重复写盘（oid 内容寻址，内容必然一致）。
 * - 用临时目录 + rename 原子落位，避免半写状态被当作「已完成」缓存。
 * 预览文件视为缓存，不做实时清理，由设置面板「数据管理」手动清理。
 */
export async function materializeToolSnapshot(
  id: string,
  oid: string
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const outDir = join(previewRoot(), id, oid)
  try {
    const dir = toolDir(id)
    if (!fs.existsSync(join(dir, '.git'))) {
      return { ok: false, error: '工具不存在或尚未建立版本库' }
    }
    // 已物化：直接复用
    if (fs.existsSync(join(outDir, 'index.html'))) {
      return { ok: true, url: `tool-preview://${id}/${oid}/index.html` }
    }

    // 收集目标 commit 树里的全部 blob 文件（相对路径 + 内容）
    const files: Array<{ path: string; content: Uint8Array }> = []
    await git.walk({
      fs,
      dir,
      trees: [git.TREE({ ref: oid })],
      map: async (filepath, [entry]) => {
        if (!entry) return
        if ((await entry.type()) === 'blob') {
          const content = await entry.content()
          if (content) files.push({ path: filepath, content })
        }
      }
    })

    // 临时目录写完后原子 rename，避免残留半写目录
    const tmpDir = join(previewRoot(), id, `${oid}.tmp-${Date.now()}`)
    try {
      for (const file of files) {
        const target = normalize(join(tmpDir, file.path))
        const root = normalize(tmpDir)
        // 防目录穿越：解析后的路径必须仍在临时目录内
        if (!target.startsWith(root)) continue
        fs.mkdirSync(dirname(target), { recursive: true })
        fs.writeFileSync(target, Buffer.from(file.content), 'utf8')
      }
      // 目录已存在（说明是此前未完成的半写目录）时先移除，再原子落位
      if (fs.existsSync(outDir)) {
        fs.rmSync(outDir, { recursive: true, force: true })
      }
      fs.renameSync(tmpDir, outDir)
    } catch (error) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      throw error
    }

    return { ok: true, url: `tool-preview://${id}/${oid}/index.html` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 递归统计目录字节数 */
function directorySize(dir: string): number {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += directorySize(p)
    } else if (entry.isFile()) {
      total += fs.statSync(p).size
    }
  }
  return total
}

/** 汇总预览缓存占用：总字节数与已物化的版本数（含所有工具）。 */
export function listPreviewCache(): { ok: true; size: number; versions: number } | { ok: false; error: string } {
  try {
    const root = previewRoot()
    if (!fs.existsSync(root)) {
      return { ok: true, size: 0, versions: 0 }
    }
    let size = 0
    let versions = 0
    for (const idEntry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!idEntry.isDirectory()) continue
      const idDir = join(root, idEntry.name)
      for (const oidEntry of fs.readdirSync(idDir, { withFileTypes: true })) {
        if (!oidEntry.isDirectory()) continue
        versions += 1
        size += directorySize(join(idDir, oidEntry.name))
      }
    }
    return { ok: true, size, versions }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 一键清空预览缓存区（幂等：目录不存在也视为成功）。 */
export function clearPreviewCache(): { ok: true } | { ok: false; error: string } {
  try {
    fs.rmSync(previewRoot(), { recursive: true, force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 解析当前 HEAD 的 commit oid；仓库尚无提交时返回 null */
async function currentHeadOid(dir: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, dir, ref: 'HEAD' })
  } catch {
    return null
  }
}

/**
 * 回滚工具到指定 commit：把该 commit 的 index.html / meta.json 写回工作区，并产生一条新提交
 * （message 形如「回滚到 <shortOid>」），不直接 reset / 移动 HEAD，历史完整可逆，回错了可再回滚。
 * 只有当目标 commit 不是当前 HEAD 时才真正产生回滚提交，避免空提交。
 * 注：用「目标 oid 是否等于 HEAD」判断是否产生提交，而非依赖 git.status 的 stat 缓存——
 *     两个 commit 若内容不同但字节数相同，stat 检测可能漏判，导致回滚内容已落盘却不生成回滚提交。
 */
export async function rollbackTool(
  id: string,
  targetOid: string
): Promise<{ ok: true; committed: boolean; oid?: string } | { ok: false; error: string }> {
  try {
    const dir = await ensureRepo(id)
    // 目标即当前 HEAD：写回内容与现状一致，无需产生新提交
    if ((await currentHeadOid(dir)) === targetOid) {
      return { ok: true, committed: false }
    }
    // 读取目标 commit 的每个白名单文件内容，写回工作区（覆盖当前版本）
    for (const file of TOOL_FILES) {
      const { blob } = await git.readBlob({ fs, dir, oid: targetOid, filepath: file })
      fs.writeFileSync(join(dir, file), Buffer.from(blob).toString('utf8'), 'utf8')
    }
    // message 带上目标提交的原始内容，便于在历史里认出被还原的改动；同时保留 shortOid 精确定位
    let message = `回滚到 ${targetOid.slice(0, 8)}`
    try {
      const { commit } = await git.readCommit({ fs, dir, oid: targetOid })
      const original = commit.message.trim()
      if (original) message = `${message}：${original}`
    } catch {
      // 读不到原始 message 时回退到默认格式
    }
    const oid = await commitSnapshot(dir, message)
    return { ok: true, committed: true, oid }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
