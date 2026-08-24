// 主进程侧：把「AI 生成的完整 HTML」保存为工具页的 index.html，并额外落盘 meta.json 元信息。
//
// 新架构「工具 = 一份可打开的完整 HTML」：AI 产出自我包含的 HTML 文档（内联 <style>/<script>），
// 宿主直接落盘到 <userData>/tools/<id>/（<id> 为宿主分配的唯一 ID，与 name 无关），其中：
//   - index.html —— 工具页主体，由 <webview> guest 经 tool:// 协议加载
//   - meta.json —— 工具元信息（id / name / 标题 / 描述），供工具列表等场景读取
// 页面交互用原生 JS 调用 window.cap.run（来自 <webview> 的 guest preload）执行原子能力；全程零模板编译、零 eval。

import { app } from 'electron'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, normalize } from 'node:path'

/** 工具页面目录根：<userData>/tools/<id>/… */
export function toolsRoot(): string {
  return join(app.getPath('userData'), 'tools')
}

export interface ToolPageInput {
  /** 宿主分配的唯一工具 ID（也是 tool:// 协议的 host 与工具文件夹名） */
  id: string
  /** AI 生成的 kebab-case 工具标识（仅作归档/展示，不做文件夹名） */
  name: string
  title: string
  description: string
  /** AI 生成的、自我包含的完整 HTML 文档源码 */
  html: string
}

/** 把 AI 生成的完整 HTML 保存为工具页 index.html 并落盘 meta.json，返回 tool:// URL。 */
export function writeToolPage(input: ToolPageInput): { url: string } {
  const dir = join(toolsRoot(), input.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), input.html, 'utf8')
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({ id: input.id, name: input.name, title: input.title, description: input.description }, null, 2),
    'utf8'
  )
  return { url: `tool://${input.id}/index.html` }
}

export interface ToolPageMeta {
  id: string
  name: string
  title: string
  description: string
}

/** 读取所有已落盘的工具元信息（遍历 <userData>/tools/<id>/meta.json），跳过无 meta.json 的残留目录。 */
export function listToolPages(): ToolPageMeta[] {
  const root = toolsRoot()
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const list: ToolPageMeta[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const metaPath = join(root, entry.name, 'meta.json')
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Partial<ToolPageMeta>
      if (!meta.id) continue
      list.push({
        id: meta.id,
        name: meta.name ?? entry.name,
        title: meta.title ?? entry.name,
        description: meta.description ?? ''
      })
    } catch {
      // 目录缺失 meta.json 或 JSON 损坏时跳过，避免残留目录或异常文件阻断整个列表
    }
  }
  return list
}

/**
 * 删除指定工具：递归移除 <userData>/tools/<id>/ 整个目录。
 * 为防止目录穿越，id 不允许包含路径分隔符或 `..`；目录不存在时视为删除成功（幂等）。
 */
export function deleteToolPage(id: string): { ok: true } | { ok: false; error: string } {
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

/** 新建工具的脚手架页：自我包含的完整 HTML（内联 <style>/<script>），可直接被 tool:// 加载。 */
export function newToolScaffoldHtml(title: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
    />
    <title>${title}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 24px; font-family: -apple-system, "PingFang SC", sans-serif; color: #1f2937; }
      .shell { max-width: 640px; margin: 0 auto; }
      code { padding: 1px 5px; border-radius: 4px; background: #f3f4f6; font-family: ui-monospace, monospace; }
      #bridge { font-size: 13px; color: #6b7280; }
    </style>
  </head>
  <body>
    <main class="shell">
      <h1>${title}</h1>
      <p>这是一个新工具。编辑 <code>index.html</code> 即可开始开发，或用 <code>window.cap.run('能力id', 参数)</code> 调用原子能力。</p>
      <p id="bridge">正在检测能力桥接…</p>
    </main>
    <script>
      const capOk = window.cap && typeof window.cap.run === 'function'
      document.getElementById('bridge').textContent = capOk ? '✓ 能力桥接可用' : '✗ 能力桥接不可用'
    </script>
  </body>
</html>
`
}

// —— 变更清单（「当前会话」code-agent 式 AI 改工具）——

/** 生成器输出的单个变更动作：整文件覆盖（write）或精确替换（patch） */
export type ToolChangeOp = 'write' | 'patch'

export interface ToolChangeAction {
  op: ToolChangeOp
  /** 工具目录内的相对文件名，白名单限 index.html / meta.json */
  file: string
  /** write：整文件内容（index.html 为字符串；meta.json 传 { name,title,description } 对象，会与现有元信息合并） */
  content?: unknown
  /** patch：需要被替换的精确查找串 */
  find?: string
  /** patch：查找串被替换成的目标串 */
  replace?: string
  /** patch：是否全局替换（默认 false，仅替换第一处） */
  replace_all?: boolean
}

/** 生成器对当前工具的一次整体改动描述 */
export interface ToolChangeList {
  /** 一句话描述本次改动 */
  summary: string
  actions: ToolChangeAction[]
}

/** 允许被生成器修改的工具内文件白名单 */
const ALLOWED_TOOL_FILES = ['index.html', 'meta.json'] as const

const META_FIELDS = ['name', 'title', 'description'] as const

interface ToolPageMetaRaw {
  id: string
  name?: string
  title?: string
  description?: string
}

function readToolMeta(dir: string): ToolPageMetaRaw {
  try {
    return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as ToolPageMetaRaw
  } catch {
    return { id: '' }
  }
}

/**
 * 应用生成器产出的变更清单到指定工具目录。
 * - 只允许写白名单文件（index.html / meta.json），并做路径归一化防目录穿越；
 * - patch 要求 find 精确命中，未命中则整单失败（避免静默改坏）；
 * - 先全量校验并计算好每个文件的最终内容，全部通过后再统一落盘。
 * 返回最新标题，供渲染层同步标签名。
 */
export function applyToolChanges(
  id: string,
  changes: ToolChangeList
): { ok: true; title: string; changedFiles: string[] } | { ok: false; error: string } {
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
  }
  const plan: PlannedWrite[] = []

  for (const action of changes.actions) {
    if (!action || typeof action !== 'object') return { ok: false, error: '存在非法变更项' }
    const file = action.file
    if (!ALLOWED_TOOL_FILES.includes(file as (typeof ALLOWED_TOOL_FILES)[number])) {
      return { ok: false, error: `不允许修改文件：${file}` }
    }
    const target = normalize(join(dir, file))
    if (!target.startsWith(root)) return { ok: false, error: `非法路径：${file}` }

    if (action.op === 'write') {
      if (file === 'meta.json') {
        const existing = readToolMeta(dir)
        const payload = (action.content ?? {}) as Partial<Record<(typeof META_FIELDS)[number], string>>
        plan.push({
          path: target,
          content: JSON.stringify(
            {
              ...existing,
              name: typeof payload.name === 'string' ? payload.name : existing.name ?? 'tool',
              title: typeof payload.title === 'string' ? payload.title : existing.title ?? '新工具',
              description:
                typeof payload.description === 'string' ? payload.description : existing.description ?? ''
            },
            null,
            2
          )
        })
      } else {
        const content = typeof action.content === 'string' ? action.content : String(action.content ?? '')
        if (!content.trim()) return { ok: false, error: `${file} 内容为空` }
        plan.push({ path: target, content })
      }
    } else if (action.op === 'patch') {
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
    writeFileSync(item.path, item.content, 'utf8')
  }

  const meta = readToolMeta(dir)
  return { ok: true, title: meta.title ?? '新工具', changedFiles: plan.map((p) => p.path) }
}
