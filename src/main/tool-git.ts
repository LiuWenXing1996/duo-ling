// 主进程侧：用 isomorphic-git 为「每个工具目录」建仓，自动记录每次文件变更。
//
// A 档（本轮）：只在创建 / 变更清单成功落盘后自动 commit，暂不做界面。
// 仓库位置：<userData>/tools/<id>/.git —— 与工具本身同目录，删除工具即连同历史删除。
// 策略：一次「成功应用的变更清单」= 一个 commit（message 用变更清单 summary）；
//       应用后若无净变更则跳过提交，避免空提交。

import git from 'isomorphic-git'
import fs from 'node:fs'
import { join } from 'node:path'
import { toolsRoot } from './tool-page'

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
        message: c.commit.message,
        author: `${c.commit.author.name} <${c.commit.author.email}>`,
        timestamp: c.commit.author.timestamp
      }))
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
