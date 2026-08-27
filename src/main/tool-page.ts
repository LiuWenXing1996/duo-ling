// 主进程侧：把「AI 生成的完整 HTML」保存为工具页的 index.html，并额外落盘 meta.json 元信息。
//
// 新架构「工具 = 一份可打开的完整 HTML」：AI 产出自我包含的 HTML 文档（内联 <style>/<script>），
// 宿主直接落盘到 <userData>/tools/<id>/（<id> 为宿主分配的唯一 ID，与 name 无关），其中：
//   - index.html —— 工具页主体，由 <webview> guest 经 tool:// 协议加载
//   - meta.json —— 工具元信息（id / name / 标题 / 描述），供工具列表等场景读取
// 页面交互用原生 JS 调用 window.cap.run（来自 <webview> 的 guest preload）执行原子能力；全程零模板编译、零 eval。

import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { isAllowedToolFile } from '../shared/tool-files'
import type {
  ToolChangeAction,
  ToolChangeList,
  ToolChangeOp,
  UserToolMeta
} from '../shared/types'

export type {
  ToolChangeAction,
  ToolChangeList,
  ToolChangeOp,
  UserToolMeta
}

/** 工具页面目录根：<userData>/tools/<id>/… */
export function toolsRoot(): string {
  return join(app.getPath('userData'), 'tools')
}

/** 生成一个足够唯一的宿主工具 ID（时间戳 + 随机段），用于工具文件夹名与 tool:// host */
export function createUserToolId(): string {
  return `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 工具版本预览缓存根：<userData>/tools-preview/<id>/<oid>/…（与 tools 兄弟目录天然隔离，进不了工具列表） */
export function previewRoot(): string {
  return join(app.getPath('userData'), 'tools-preview')
}

/** 图标归一化：仅接受「单个字符」（按码点计 1），返回原字符；其余（空/多字符/空白）一律返回 ''。 */
export function normalizeToolIcon(icon: unknown): string {
  if (typeof icon !== 'string') return ''
  const t = icon.trim()
  if (!t) return ''
  return [...t].length === 1 ? t : ''
}

/** 读取所有已落盘的工具元信息（遍历 <userData>/tools/<id>/meta.json），跳过无 meta.json 的残留目录。 */
export function listUserTools(): UserToolMeta[] {
  const root = toolsRoot()
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const list: UserToolMeta[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const metaPath = join(root, entry.name, 'meta.json')
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Partial<UserToolMeta>
      if (!meta.id) continue
      list.push({
        id: meta.id,
        name: meta.name ?? entry.name,
        title: meta.title ?? entry.name,
        description: meta.description ?? '',
        icon: normalizeToolIcon(meta.icon),
        ...(Array.isArray(meta.capabilities) ? { capabilities: meta.capabilities } : {})
      })
    } catch {
      // 目录缺失 meta.json 或 JSON 损坏时跳过，避免残留目录或异常文件阻断整个列表
    }
  }
  return list
}

/**
 * 读取指定路径的工具 meta（正式页传 <userData>/tools/<id>/meta.json，预览页传 commit 物化出的 meta）。
 * 用于主进程对 cap.run 的按工具/按版本能力白名单校验；文件缺失或损坏返回 null。
 */
export function readUserToolMetaAt(metaPath: string): UserToolMeta | null {
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Partial<UserToolMeta>
    return meta.id ? (meta as UserToolMeta) : null
  } catch {
    return null
  }
}

/**
 * 更新某工具的元信息：读现有 meta.json，仅合并传入的字段后落盘。
 * - title 去除首尾空白，为空时保留原值（避免标签名被清空）
 * - description 去除首尾空白，允许清空
 * - icon 归一化为单个字符（非法/空则清空，由渲染层用工具名首字符兜底）
 * meta.json 不存在或损坏时返回错误，不凭空创建残缺元信息。
 */
export function updateUserToolMeta(
  id: string,
  patch: { title?: string; description?: string; icon?: unknown }
): { ok: true; title: string; icon: string } | { ok: false; error: string } {
  if (!id || typeof id !== 'string') return { ok: false, error: '缺少工具 id' }
  const dir = join(toolsRoot(), id)
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as Partial<UserToolMeta>
    const next: Partial<UserToolMeta> = { ...meta }
    if (typeof patch.title === 'string') {
      const t = patch.title.trim()
      if (t) next.title = t
    }
    if (typeof patch.description === 'string') next.description = patch.description.trim()
    if ('icon' in patch) next.icon = normalizeToolIcon(patch.icon)
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...next, id: meta.id ?? id }, null, 2), 'utf8')
    return { ok: true, title: next.title ?? '', icon: next.icon ?? '' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 删除指定工具：递归移除 <userData>/tools/<id>/ 整个目录。
 * 为防止目录穿越，id 不允许包含路径分隔符或 `..`；目录不存在时视为删除成功（幂等）。
 */
export function deleteUserTool(id: string): { ok: true } | { ok: false; error: string } {
  if (!id || typeof id !== 'string' || id.includes('..') || id.includes('/') || id.includes('\\')) {
    return { ok: false, error: '非法工具 id' }
  }
  try {
    rmSync(join(toolsRoot(), id), { recursive: true, force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 工具页 CSP 策略：作为 `tool://` / `tool-preview://` 响应头权威下发，同时与脚手架 meta 保持同一来源，防双写漂移。 */
export const TOOL_PAGE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"

/** 新建工具的脚手架页（目录骨架）：入口页引用 ./css/style.css 与 ./js/main.js，可直接被 tool:// 加载。 */
export function newUserToolScaffoldHtml(title: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${TOOL_PAGE_CSP}" />
    <title>${title}</title>
    <link rel="stylesheet" href="./css/style.css" />
  </head>
  <body>
    <main class="shell">
      <h1>${title}</h1>
      <p>这是一个新工具。编辑 <code>index.html</code> / <code>js/main.js</code> / <code>css/style.css</code> 即可开始开发，或用 <code>window.cap.run('能力id', 参数)</code> 调用原子能力。</p>
      <p id="bridge">正在检测能力桥接…</p>
    </main>
    <script type="module" src="./js/main.js"></script>
  </body>
</html>
`
}

/** 工具入口脚本：能力桥接检测 + 后续可拆分模块（import './lib/util.js' 等） */
const SCAFFOLD_MAIN_JS = `// 工具入口脚本：能力桥接检测；可继续拆分子模块（import './lib/util.js' 等）
const capOk = window.cap && typeof window.cap.run === 'function'
document.getElementById('bridge').textContent = capOk ? '✓ 能力桥接可用' : '✗ 能力桥接不可用'
`

/** 工具样式：与脚手架页面配套 */
const SCAFFOLD_STYLE_CSS = `* { box-sizing: border-box; }
body { margin: 0; padding: 24px; font-family: -apple-system, "PingFang SC", sans-serif; color: #1f2937; }
.shell { max-width: 640px; margin: 0 auto; }
code { padding: 1px 5px; border-radius: 4px; background: #f3f4f6; font-family: ui-monospace, monospace; }
#bridge { font-size: 13px; color: #6b7280; }
`

/** 脚手架目录骨架文件集合（不含 meta.json，由 writeUserToolScaffold 统一落盘） */
export function userToolScaffoldFiles(title: string): { rel: string; content: string }[] {
  return [
    { rel: 'index.html', content: newUserToolScaffoldHtml(title) },
    { rel: 'js/main.js', content: SCAFFOLD_MAIN_JS },
    { rel: 'css/style.css', content: SCAFFOLD_STYLE_CSS }
  ]
}

/** 以目录骨架落盘一个新工具：index.html + js/ + css/ + 空 assets/ + meta.json，返回 tool:// URL。 */
export function writeUserToolScaffold(input: {
  id: string
  name: string
  title: string
  description: string
  icon?: string
  capabilities?: string[]
}): { url: string } {
  const dir = join(toolsRoot(), input.id)
  for (const sub of ['js', 'css', 'assets']) {
    mkdirSync(join(dir, sub), { recursive: true })
  }
  for (const file of userToolScaffoldFiles(input.title)) {
    writeFileSync(join(dir, file.rel), file.content, 'utf8')
  }
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify(
      {
        id: input.id,
        name: input.name,
        title: input.title,
        description: input.description,
        icon: normalizeToolIcon(input.icon),
        ...(input.capabilities?.length ? { capabilities: input.capabilities } : {})
      },
      null,
      2
    ),
    'utf8'
  )
  return { url: `tool://${input.id}/index.html` }
}

// —— 变更清单（「当前会话」code-agent 式 AI 改工具）——
//
// ToolChangeOp / ToolChangeAction / ToolChangeList 已收敛至 src/shared/types.ts（见文件顶部 re-export）。
// 可写文件白名单见 src/shared/tool-files.ts（与 git 遍历、生成器侧保持一致）。

const META_FIELDS = ['name', 'title', 'description', 'icon', 'capabilities'] as const

interface UserToolMetaRaw {
  id: string
  name?: string
  title?: string
  description?: string
  icon?: string
  capabilities?: string[]
}

function readUserToolMeta(dir: string): UserToolMetaRaw {
  try {
    return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as UserToolMetaRaw
  } catch {
    return { id: '' }
  }
}

/**
 * 读取工具目录内全部白名单文件（排除 .git），供 AgentTool「读取」链路。
 * 文本文件（utf8 可无损解码）返回 content 原文；二进制（如 assets 图片）返回 base64 + encoding 标记。
 */
export function readUserToolTree(
  id: string
): Array<{ path: string; content: string; encoding: 'utf8' | 'base64' }> {
  const dir = join(toolsRoot(), id)
  const out: Array<{ path: string; content: string; encoding: 'utf8' | 'base64' }> = []
  const walk = (cur: string, rel: string): void => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      const abs = join(cur, entry.name)
      if (entry.isDirectory()) {
        walk(abs, relPath)
      } else if (isAllowedToolFile(relPath)) {
        const buf = readFileSync(abs)
        const text = buf.toString('utf8')
        if (text.includes('\uFFFD')) {
          out.push({ path: relPath, content: buf.toString('base64'), encoding: 'base64' })
        } else {
          out.push({ path: relPath, content: text, encoding: 'utf8' })
        }
      }
    }
  }
  walk(dir, '')
  return out
}

/**
 * 应用生成器产出的变更清单到指定工具目录。
 * - 只允许写白名单内文件（根级 index.html / meta.json / archive.md + js/ css/ assets/ 子目录，见 shared/tool-files.ts）；
 * - patch 要求 find 精确命中，未命中则整单失败（避免静默改坏）；
 * - 先全量校验并计算好每个文件的最终内容，全部通过后再统一落盘。
 * 返回最新标题，供渲染层同步标签名。
 */
export function applyToolChanges(
  id: string,
  changes: ToolChangeList
): { ok: true; title: string; changedFiles: string[] } | { ok: false; error: string } {
  try {
    if (!id || typeof id !== 'string') return { ok: false, error: '缺少工具 id' }
    if (!changes || !Array.isArray(changes.actions) || changes.actions.length === 0) {
      return { ok: false, error: '缺少可执行的变更' }
    }

    const dir = join(toolsRoot(), id)
    mkdirSync(dir, { recursive: true })
    const root = normalize(toolsRoot())

    // 先做全量校验与目标内容计算，再做原子落盘，避免中途失败留下半写状态
    interface PlannedWrite {
      path: string
      content: string
      /** assets/ 下的二进制资产：以 base64 写入，不走 utf8 文本路径 */
      binary?: Buffer
    }
    const plan: PlannedWrite[] = []

    for (const action of changes.actions) {
      if (!action || typeof action !== 'object') return { ok: false, error: '存在非法变更项' }
      const file = action.file
      if (!isAllowedToolFile(file)) {
        return { ok: false, error: `不允许修改文件：${file}` }
      }
      const target = normalize(join(dir, file))
      if (!target.startsWith(root)) return { ok: false, error: `非法路径：${file}` }

      if (action.op === 'write') {
        if (file === 'meta.json') {
          const existing = readUserToolMeta(dir)
          const payload = (action.content ?? {}) as Partial<
            Record<(typeof META_FIELDS)[number], unknown>
          >
          plan.push({
            path: target,
            content: JSON.stringify(
              {
                ...existing,
                name: typeof payload.name === 'string' ? payload.name : existing.name ?? 'tool',
                title: typeof payload.title === 'string' ? payload.title : existing.title ?? '新工具',
                description:
                  typeof payload.description === 'string' ? payload.description : existing.description ?? '',
                icon:
                  typeof payload.icon === 'string'
                    ? normalizeToolIcon(payload.icon)
                    : existing.icon ?? '',
                ...(Array.isArray(payload.capabilities) && payload.capabilities.length
                  ? { capabilities: payload.capabilities.filter((c): c is string => typeof c === 'string') }
                  : {})
              },
              null,
              2
            )
          })
        } else if (file.startsWith('assets/')) {
          // 静态资源：二进制资产，content 为 base64（字符串或 { base64 }），只支持 write
          const raw = action.content
          const base64 =
            typeof raw === 'string'
              ? raw
              : raw && typeof raw === 'object' && typeof (raw as { base64?: unknown }).base64 === 'string'
                ? (raw as { base64: string }).base64
                : ''
          if (!base64) return { ok: false, error: `资产「${file}」内容需为 base64` }
          const buf = Buffer.from(base64, 'base64')
          if (buf.length === 0 && base64.trim() !== '') {
            return { ok: false, error: `资产「${file}」base64 解码失败` }
          }
          plan.push({ path: target, content: '', binary: buf })
        } else {
          const content = typeof action.content === 'string' ? action.content : String(action.content ?? '')
          if (!content.trim()) return { ok: false, error: `${file} 内容为空` }
          plan.push({ path: target, content })
        }
      } else if (action.op === 'patch') {
        if (!existsSync(target)) return { ok: false, error: `「${file}」不存在，无法 patch` }
        const src = readFileSync(target, 'utf8')
        const find = typeof action.find === 'string' ? action.find : ''
        if (!find) return { ok: false, error: `patch「${file}」缺少 find` }
        if (!src.includes(find)) return { ok: false, error: `「${file}」中未找到匹配内容` }
        const replace = typeof action.replace === 'string' ? action.replace : ''
        const next = action.replace_all ? src.split(find).join(replace) : src.replace(find, replace)
        plan.push({ path: target, content: next })
      } else {
        return { ok: false, error: `未知操作：${String(action.op)}` }
      }
    }

    for (const item of plan) {
      mkdirSync(dirname(item.path), { recursive: true })
      if (item.binary) {
        writeFileSync(item.path, item.binary)
      } else {
        writeFileSync(item.path, item.content, 'utf8')
      }
    }

    const meta = readUserToolMeta(dir)
    return { ok: true, title: meta.title ?? '新工具', changedFiles: plan.map((p) => p.path) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
