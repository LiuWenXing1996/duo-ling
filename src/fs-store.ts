// 存储层：用 lightning-fs（IndexedDB 后端）替换桌面版的 node:fs，
// 用 isomorphic-git（纯 JS）替换系统 git。对应迁移方案 §4.4 / §4.5。
import LightningFS from '@isomorphic-git/lightning-fs'
import git from 'isomorphic-git'

// 单一 fs 实例，所有工具共用一个 IndexedDB 库（dbname='duoling'）。
// 注意：lightning-fs 只有异步 API（pfs），这是相对桌面版 node:fs 同步 API 的真实改造点。
export const fs = new LightningFS('duoling')
export const pfs = fs.promises

const AUTHOR = { name: 'duoling', email: 'dev@duoling.local' }

/** 幂等：确保工具目录与 git 仓存在 */
export async function ensureToolRepo(toolId: string): Promise<void> {
  const dir = `/${toolId}`
  try {
    await pfs.mkdir(dir)
  } catch {
    /* 已存在则忽略 */
  }
  try {
    await git.init({ fs, dir, defaultBranch: 'main' })
  } catch {
    /* 已 init 则忽略（isomorphic-git 对已有仓会抛错） */
  }
}

export async function writeToolFile(toolId: string, filepath: string, content: string): Promise<void> {
  await pfs.writeFile(`/${toolId}/${filepath}`, content)
}

export async function readToolFile(toolId: string, filepath: string): Promise<string> {
  return (await pfs.readFile(`/${toolId}/${filepath}`, 'utf8')) as string
}

/** 提交工具目录下 output.html（只跟踪该文件，对应桌面版 applyToolChanges 的受控写入） */
export async function commit(toolId: string, message: string): Promise<string> {
  await git.add({ fs, dir: `/${toolId}`, filepath: 'output.html' })
  return git.commit({ fs, dir: `/${toolId}`, message, author: AUTHOR })
}

/** 回滚：把工作区恢复到上一版本（证伪版本/回滚闭环） */
export async function rollback(toolId: string): Promise<string> {
  const dir = `/${toolId}`
  const log = await git.log({ fs, dir })
  if (log.length < 2) {
    // 只有一个或零个提交，无法回滚
    throw new Error('no previous version to rollback to')
  }
  const prevOid = log[1].oid // log[0] 是 HEAD，log[1] 是上一版
  await git.checkout({ fs, dir, ref: prevOid, force: true })
  return readToolFile(toolId, 'output.html')
}

/** 极简 markdown 渲染器（spike 用，不引入额外依赖） */
export function miniRender(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const lines = md.split('\n')
  let html = ''
  for (const line of lines) {
    const h = line.match(/^(#{1,3})\s+(.*)/)
    if (h) {
      const lvl = h[1].length
      html += `<h${lvl}>${esc(h[2])}</h${lvl}>\n`
      continue
    }
    if (line.trim() === '') continue
    html += `<p>${esc(line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'))}</p>\n`
  }
  return html
}
