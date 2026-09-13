// 工具存储层：lightning-fs（IndexedDB 后端）+ isomorphic-git（纯 JS git）。
// 对应迁移方案 §4.4 / §4.5：替换桌面版的 node:fs 与系统 git。
//
// 目录约定（平移自桌面版 shared/tool-files.ts 的白名单）：
//   /tools/<toolId>/
//   ├── index.html    工具入口（工具页，sandbox iframe 以 srcdoc 注入）
//   ├── meta.json     工具元信息（title / description / icon / capabilities）
//   ├── archive.md    工具档案
//   ├── js/ css/ assets/   可嵌套的静态资源
//
// 注意：lightning-fs 只有异步 API（pfs），这是相对桌面版同步调用（readdirSync 等）的真实改造点。
import LightningFS from '@isomorphic-git/lightning-fs'
import git from 'isomorphic-git'
import { isAllowedToolFile } from './shared/tool-files'
import { scaffoldFiles } from './tool-page-template'
import type { ToolChangeList, ToolCodeFile, ToolCommit, UserToolMeta } from './shared/types'

export const fs = new LightningFS('duoling')
export const pfs = fs.promises

const AUTHOR = { name: 'duoling', email: 'dev@duoling.local' }
const TOOLS_ROOT = '/tools'

export const toolDir = (toolId: string): string => `${TOOLS_ROOT}/${toolId}`
export const toolPath = (toolId: string, relative: string): string => `${toolDir(toolId)}/${relative}`

/** 幂等：确保 /tools 根目录存在 */
export async function ensureToolsRoot(): Promise<void> {
  try {
    await pfs.mkdir(TOOLS_ROOT)
  } catch {
    /* 已存在则忽略 */
  }
}

/** 幂等：确保工具目录与 git 仓存在 */
export async function ensureToolRepo(toolId: string): Promise<void> {
  await ensureToolsRoot()
  const dir = toolDir(toolId)
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
  await pfs.writeFile(toolPath(toolId, filepath), content)
}

export async function readToolFile(toolId: string, filepath: string): Promise<string> {
  return (await pfs.readFile(toolPath(toolId, filepath), 'utf8')) as string
}

export async function fileExists(toolId: string, filepath: string): Promise<boolean> {
  try {
    await pfs.stat(toolPath(toolId, filepath))
    return true
  } catch {
    return false
  }
}

/** 列出全部工具 id（/tools 下的目录） */
export async function listToolIds(): Promise<string[]> {
  try {
    await ensureToolsRoot()
    const entries = (await pfs.readdir(TOOLS_ROOT)) as string[]
    const ids: string[] = []
    for (const name of entries) {
      const st = await pfs.stat(`${TOOLS_ROOT}/${name}`)
      if (st.type === 'dir') ids.push(name)
    }
    return ids.sort()
  } catch {
    return []
  }
}

/** 读取工具元信息（meta.json）；缺失或损坏时返回 undefined，由调用方兜底。
 *  icon 在此归一化（对齐桌面版 listUserTools）：渲染层直接按值取字符或 lucide 名。 */
export async function readToolMeta(toolId: string): Promise<UserToolMeta | undefined> {
  try {
    const raw = await readToolFile(toolId, 'meta.json')
    const parsed = JSON.parse(raw) as Partial<UserToolMeta>
    return {
      id: toolId,
      name: parsed.name ?? toolId,
      title: parsed.title ?? parsed.name ?? toolId,
      description: parsed.description ?? '',
      icon: normalizeToolIcon(parsed.icon),
      capabilities: parsed.capabilities,
    }
  } catch {
    return undefined
  }
}

/**
 * 全部已落盘工具（对齐桌面版 listUserTools）。
 * 只认有 meta.json 的目录：残留目录（meta 丢失或损坏）不进列表，
 * 否则会在工具网格里出现一条无标题的幽灵工具。
 */
export async function listTools(): Promise<UserToolMeta[]> {
  const metas: UserToolMeta[] = []
  for (const id of await listToolIds()) {
    const meta = await readToolMeta(id)
    if (meta) metas.push(meta)
  }
  return metas
}

export async function writeToolMeta(toolId: string, meta: UserToolMeta): Promise<void> {
  await writeToolFile(toolId, 'meta.json', JSON.stringify(meta, null, 2))
}

/** 递归列出工具目录下的文件（跳过 .git），用于代码浏览与提交 */
async function walk(dir: string, base = ''): Promise<string[]> {
  const out: string[] = []
  let entries: string[]
  try {
    entries = (await pfs.readdir(dir)) as string[]
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === '.git') continue
    const rel = base ? `${base}/${name}` : name
    const st = await pfs.stat(`${dir}/${name}`)
    if (st.type === 'dir') out.push(...(await walk(`${dir}/${name}`, rel)))
    else out.push(rel)
  }
  return out
}

/** 工具源码（代码浏览用；文本文件返回 utf8，其余标记 base64）。
 *  与桌面版 readUserToolTree 对齐：只列白名单内文件（index.html / meta.json / archive.md 与
 *  js/ css/ assets/ 下任意文件），并按内容是否含替换字符判定二进制。 */
export async function listToolFiles(toolId: string): Promise<ToolCodeFile[]> {
  const paths = (await walk(toolDir(toolId))).filter(isAllowedToolFile).sort()
  const result: ToolCodeFile[] = []
  for (const path of paths) {
    try {
      const buf = (await pfs.readFile(toolPath(toolId, path))) as Uint8Array
      const text = new TextDecoder().decode(buf)
      if (text.includes('\uFFFD')) {
        result.push({ path, content: bytesToBase64(buf), encoding: 'base64' })
      } else {
        result.push({ path, content: text, encoding: 'utf8' })
      }
    } catch {
      result.push({ path, content: '', encoding: 'base64' })
    }
  }
  return result
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** 提交工具目录下的全部受控文件（对应桌面版 applyToolChanges 的受控写入） */
export async function commit(toolId: string, message: string): Promise<string> {
  const dir = toolDir(toolId)
  const files = await walk(dir)
  for (const filepath of files) {
    await git.add({ fs, dir, filepath })
  }
  return git.commit({ fs, dir, message, author: AUTHOR })
}

/** 提交历史（新提交在前）。
 *  timestamp 用 Unix **秒**、author 用 `名字 <邮箱>` —— 与桌面版 listToolHistory 一致，
 *  渲染层 ToolHistory 的 formatTimestamp 也按秒解析（改成毫秒会显示成公元 5 万年）。 */
export async function listCommits(toolId: string): Promise<ToolCommit[]> {
  const dir = toolDir(toolId)
  try {
    const log = await git.log({ fs, dir })
    return log.map((entry) => ({
      oid: entry.oid,
      message: entry.commit.message.trim(),
      author: `${entry.commit.author.name} <${entry.commit.author.email}>`,
      timestamp: entry.commit.author.timestamp,
    }))
  } catch {
    // git.init 尚未产生任何提交时 git.log 会抛错，视为空历史
    return []
  }
}

/** 读取某个提交下的文件内容（版本对比/预览用） */
export async function readFileAtCommit(toolId: string, oid: string, filepath: string): Promise<string> {
  const dir = toolDir(toolId)
  const { blob } = await git.readBlob({ fs, dir, oid, filepath })
  return new TextDecoder().decode(blob)
}

/** 工具目录相对上次提交是否有净变更（对齐桌面版 hasToolChanges，用于跳过空提交） */
export async function hasToolChanges(toolId: string): Promise<boolean> {
  const dir = toolDir(toolId)
  let headExists = true
  try {
    await git.resolveRef({ fs, dir, ref: 'HEAD' })
  } catch {
    headExists = false
  }
  // 仓库尚无任何提交（如旧工具首次被改）：视为有变更，走首提
  if (!headExists) return true
  const files = await walk(dir)
  if (files.length === 0) return false
  const statuses = await Promise.all(files.map((f) => git.status({ fs, dir, filepath: f })))
  return statuses.some((s) => s !== 'unmodified')
}

/**
 * 有净变更才提交（对齐桌面版 commitToolChanges）。
 * 工具页每次「渲染并提交」都调用它：内容没变时不产生提交，
 * 否则版本历史里会堆一串内容完全相同的记录，回滚时也分不清哪条才有意义。
 */
export async function commitIfChanged(
  toolId: string,
  message: string,
): Promise<{ committed: boolean; oid?: string }> {
  await ensureToolRepo(toolId)
  if (!(await hasToolChanges(toolId))) return { committed: false }
  const oid = await commit(toolId, message.trim() || '更新工具')
  return { committed: true, oid }
}

/** 读取当前工作区的 index.html（工具页承载用） */
export async function readToolPage(toolId: string): Promise<string> {
  return readToolFile(toolId, 'index.html')
}

/** 递归删除，用于工具删除（git 仓随目录一并清除，避免孤儿数据） */
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

/** 工具 id 安全性：不允许路径分隔符与 `..`（对齐桌面版 deleteUserTool 的防穿越校验）。
 *  id 来自渲染层与工具页，若为 `../../x` 一类值，删除操作会越出 /tools 根。 */
function assertSafeToolId(toolId: unknown): asserts toolId is string {
  if (
    typeof toolId !== 'string' ||
    !toolId ||
    toolId.includes('..') ||
    toolId.includes('/') ||
    toolId.includes('\\')
  ) {
    throw new Error('非法工具 id')
  }
}

export async function deleteTool(toolId: string): Promise<void> {
  assertSafeToolId(toolId)
  try {
    await removeRecursive(toolDir(toolId))
  } catch {
    /* 目录不存在视为已删除 */
  }
}

// —— 工具生命周期（平移桌面版 tool-page.ts / tool-git.ts 的宿主侧实现，改为 lightning-fs 异步版）——

/** 生成宿主工具 id（时间戳 base36 + 随机段），与桌面版 createUserToolId 同构 */
export function createToolId(): string {
  return `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 图标归一化，接受两种格式：
 * - 单个字符（按码点计 1，emoji / 字母 / 汉字等），原样返回
 * - `lucide:<kebab-case 名称>`，小写化后返回（渲染层按需动态加载 lucide 图标）
 * 其余（空 / 多字符 / 非法名称）一律返回 ''
 */
export function normalizeToolIcon(icon: unknown): string {
  if (typeof icon !== 'string') return ''
  const t = icon.trim()
  if (!t) return ''
  if (t.startsWith('lucide:')) {
    const name = t.slice('lucide:'.length).toLowerCase()
    return /^[a-z0-9-]+$/.test(name) ? `lucide:${name}` : ''
  }
  return [...t].length === 1 ? t : ''
}

/** 新建工具：落盘脚手架并做「创建工具」首提；git 失败不阻断创建（与桌面版一致） */
export async function createTool(): Promise<
  { ok: true; id: string; title: string } | { ok: false; error: string }
> {
  try {
    const id = createToolId()
    const title = '新工具'
    await ensureToolRepo(id)
    for (const file of scaffoldFiles(title)) {
      await writeToolFile(id, file.rel, file.content)
    }
    await writeToolMeta(id, { id, name: 'new-tool', title, description: '', icon: '' })
    try {
      await commit(id, '创建工具')
    } catch {
      /* 首次提交失败不阻断创建：目录可用即可，后续操作会再提交 */
    }
    return { ok: true, id, title }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 更新工具元信息：仅合并传入字段；title 去空白、为空保留原值，icon 归一化。
 *  meta.json 缺失或损坏时报错而不凭空创建（对齐桌面版 updateUserToolMeta）——
 *  否则一次改标题就会把残缺元信息（title = 目录名）永久写进工具。 */
export async function updateToolMeta(
  toolId: string,
  patch: { title?: string; description?: string; icon?: string }
): Promise<{ ok: true; title: string; icon: string } | { ok: false; error: string }> {
  if (!toolId || typeof toolId !== 'string') return { ok: false, error: '缺少工具 id' }
  try {
    const current = await readToolMeta(toolId)
    if (!current) return { ok: false, error: '工具元信息不存在或已损坏，无法更新' }
    const next: UserToolMeta = { ...current }
    if (typeof patch.title === 'string' && patch.title.trim()) next.title = patch.title.trim()
    if (typeof patch.description === 'string') next.description = patch.description.trim()
    if ('icon' in patch) next.icon = normalizeToolIcon(patch.icon)
    await writeToolMeta(toolId, next)
    return { ok: true, title: next.title, icon: next.icon ?? '' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 读取工具档案 archive.md；未创建时返回空串（面板展示「暂无档案」初态） */
export async function readArchive(
  toolId: string,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  if (!toolId || typeof toolId !== 'string') return { ok: false, error: '缺少工具 id' }
  try {
    if (!(await fileExists(toolId, 'archive.md'))) return { ok: true, content: '' }
    return { ok: true, content: await readToolFile(toolId, 'archive.md') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 读取某提交下的工具页 HTML（版本预览用） */
export async function readPageAtCommit(toolId: string, oid: string): Promise<string> {
  return readFileAtCommit(toolId, oid, 'index.html')
}

/** 目标提交树中的全部 blob 相对路径（目录 / 子模块不计入） */
async function listTreeFiles(toolId: string, oid: string): Promise<string[]> {
  const files: string[] = []
  await git.walk({
    fs,
    dir: toolDir(toolId),
    trees: [git.TREE({ ref: oid })],
    map: async (filepath, [entry]) => {
      if (!entry) return
      if ((await entry.type()) === 'blob') files.push(filepath)
    },
  })
  return files
}

/**
 * 回滚到指定提交：把该提交整棵树写回工作区，并产生一条新提交（不 reset、不移动历史）。
 * 平移自桌面版 rollbackTool —— 与 `revertToCommit`（git.checkout）的关键区别：
 * checkout 会移动 HEAD、丢掉其后的提交；这里历史完整可逆，回错了可以再回滚。
 */
export async function rollbackToCommit(
  toolId: string,
  targetOid: string,
): Promise<{ ok: true; committed: boolean; oid?: string } | { ok: false; error: string }> {
  const dir = toolDir(toolId)
  try {
    const log = await listCommits(toolId)
    // 目标即当前 HEAD：写回内容与现状一致，无需产生新提交（避免空提交）
    if (log[0]?.oid === targetOid) return { ok: true, committed: false }

    for (const filepath of await listTreeFiles(toolId, targetOid)) {
      const { blob } = await git.readBlob({ fs, dir, oid: targetOid, filepath })
      await writeToolFile(toolId, filepath, new TextDecoder().decode(blob))
    }

    let message = `回滚到 ${targetOid.slice(0, 8)}`
    try {
      const { commit: target } = await git.readCommit({ fs, dir, oid: targetOid })
      const original = target.message.trim()
      if (original) message = `${message}：${original}`
    } catch {
      /* 读不到原始 message 时用默认格式 */
    }
    const oid = await commit(toolId, message)
    return { ok: true, committed: true, oid }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 应用生成器产出的变更清单（平移自桌面版 applyToolChanges）：**先全量校验并算出每个文件的最终内容，
 * 全部通过后再统一落盘**，中途任一条不合法则整单失败、不留半写状态；成功则提交一次。
 * 变更清单由 AI 产出，宿主的职责是「校验 + 落盘」，不放开 AI 直接碰存储。
 *
 * 与桌面的已知差异：返回的 changedFiles 是相对路径（桌面版返回绝对路径），
 * 渲染层只用来展示改动了哪些文件，相对路径更有意义。
 */
export async function applyToolChanges(
  toolId: string,
  changes: ToolChangeList,
): Promise<{ ok: true; title?: string; changedFiles?: string[] } | { ok: false; error: string }> {
  if (!toolId || typeof toolId !== 'string') return { ok: false, error: '缺少工具 id' }
  if (!changes || !Array.isArray(changes.actions) || changes.actions.length === 0) {
    return { ok: false, error: '缺少可执行的变更' }
  }
  interface PlannedWrite {
    file: string
    content?: string
    /** assets/ 下的二进制资产：以 base64 解码后的字节写入，不走文本路径 */
    bytes?: Uint8Array
  }
  const plan: PlannedWrite[] = []
  try {
    let current = await readToolMeta(toolId)

    for (const action of changes.actions) {
      if (!action || typeof action !== 'object') return { ok: false, error: '存在非法变更项' }
      const file = action.file?.replace(/^\.\//, '')
      if (!isAllowedToolFile(file)) {
        return { ok: false, error: `文件不在工具白名单内：${action.file}` }
      }
      // TS：isAllowedToolFile 是类型谓词之外的真值校验，此处已确定 file 为非空 string
      const rel = file!

      if (action.op === 'write') {
        if (rel === 'meta.json') {
          // meta.json 走字段级合并（对齐桌面版）：未传的字段保留原值，name / title 有默认兜底，
          // capabilities 只在传入非空数组时覆盖。
          const payload = (action.content ?? {}) as Partial<Record<string, unknown>>
          const merged: UserToolMeta = {
            id: toolId,
            name: typeof payload.name === 'string' ? payload.name : (current?.name ?? 'tool'),
            title: typeof payload.title === 'string' ? payload.title : (current?.title ?? '新工具'),
            description:
              typeof payload.description === 'string'
                ? payload.description
                : (current?.description ?? ''),
            icon:
              typeof payload.icon === 'string' ? normalizeToolIcon(payload.icon) : current?.icon ?? '',
            ...(Array.isArray(payload.capabilities) && payload.capabilities.length
              ? {
                  capabilities: payload.capabilities.filter(
                    (c): c is string => typeof c === 'string',
                  ),
                }
              : {}),
          }
          plan.push({ file: rel, content: JSON.stringify(merged, null, 2) })
          current = merged
        } else if (rel.startsWith('assets/')) {
          // 静态资源按 base64 落盘（桌面版同样约定）：字符串或 { base64 } 两种形态
          const raw = action.content
          const base64 =
            typeof raw === 'string'
              ? raw
              : raw && typeof raw === 'object' && typeof (raw as { base64?: unknown }).base64 === 'string'
                ? (raw as { base64: string }).base64
                : ''
          if (!base64) return { ok: false, error: `资产「${rel}」内容需为 base64` }
          const bytes = base64ToBytes(base64)
          if (!bytes) return { ok: false, error: `资产「${rel}」base64 解码失败` }
          plan.push({ file: rel, bytes })
        } else {
          const content = typeof action.content === 'string' ? action.content : String(action.content ?? '')
          if (!content.trim()) return { ok: false, error: `${rel} 内容为空` }
          plan.push({ file: rel, content })
        }
        continue
      }

      if (action.op === 'patch') {
        // patch 以「盘上的当前内容」为基准，若同一单里前面已规划过该文件，需以规划内容为准
        const planned = plan.find((p) => p.file === rel)
        let source: string
        if (planned) {
          if (planned.bytes) return { ok: false, error: `${rel} 是二进制资产，不支持 patch` }
          source = planned.content ?? ''
        } else {
          try {
            source = await readToolFile(toolId, rel)
          } catch {
            return { ok: false, error: `「${rel}」不存在，无法 patch` }
          }
        }
        const find = typeof action.find === 'string' ? action.find : ''
        if (!find) return { ok: false, error: `${rel} 的 patch 缺少 find` }
        if (!source.includes(find)) return { ok: false, error: `${rel} 中未找到待替换内容` }
        const replace = typeof action.replace === 'string' ? action.replace : ''
        const next = action.replace_all ? source.split(find).join(replace) : source.replace(find, replace)
        if (planned) planned.content = next
        else plan.push({ file: rel, content: next })
        continue
      }

      return { ok: false, error: `未知操作：${String(action.op)}` }
    }

    // 校验全通过，统一落盘
    for (const item of plan) {
      const abs = toolPath(toolId, item.file)
      await ensureDir(abs.slice(0, abs.lastIndexOf('/')))
      if (item.bytes) await pfs.writeFile(abs, item.bytes)
      else await pfs.writeFile(abs, item.content ?? '')
    }

    // 一次变更清单 = 一个 commit
    if (plan.length) await commit(toolId, changes.summary?.trim() || '更新工具')
    const meta = await readToolMeta(toolId)
    return { ok: true, title: meta?.title, changedFiles: plan.map((p) => p.file) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

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

/** base64 → 字节；非法输入返回 null（避免静默写出空文件） */
function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/** 极简 markdown 渲染器（一期离线能力用，后续由 capability-registry 全量替换） */
export function miniRender(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const lines = md.split('\n')
  let html = ''
  for (const line of lines) {
    const h = line.match(/^(#{1,3})\s+(.*)/)
    if (h) {
      const level = h[1]?.length ?? 1
      html += `<h${level}>${esc(h[2] ?? '')}</h${level}>\n`
      continue
    }
    if (line.trim() === '') continue
    html += `<p>${esc(line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'))}</p>\n`
  }
  return html
}
