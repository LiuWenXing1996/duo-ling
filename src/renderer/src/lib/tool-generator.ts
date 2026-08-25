// 生成器（PRD §6 生成期）的渲染层数据模型与解析逻辑。
//
// 新架构「工具 = 一份可打开的完整 HTML」：AI 直接产出 { name, title, description, html }。
//   - html 是自我包含的完整 HTML 文档（内联 <style>/<script>）；
//   - 页面交互用原生 JS 调用 window.cap.run('能力id', 参数对象) 执行原子能力。
// 本层负责解析这份定义（parseGeneratedTool）、提取依赖的能力 id（extractCapabilities）并做覆盖校验（buildCoverage）。
//
// 关键：全程零模板编译、零 new Function / eval —— AI 产出即浏览器可解析的原生 HTML，天然通过 CSP。

import type { CapabilityItem } from './capability-runner'

/** 由 LLM 生成的工具定义（AI 产出完整 HTML 文档 + 元信息） */
export interface GeneratedToolDef {
  /** kebab-case 唯一 id */
  name: string
  title: string
  description: string
  /** 自我包含的完整 HTML 文档（内联 <style>/<script>，用 window.cap.run 调能力） */
  html: string
  /** 本工具声明可调用的能力 id 白名单；缺省视为不声明任何能力 */
  capabilities?: string[]
}

export interface CoverageReport {
  tool: GeneratedToolDef
  /** html 中用到的、且现有能力可覆盖的能力 id */
  covered: string[]
  /** html 中用到的、但现有能力缺失的能力 id */
  missing: string[]
}

// —— 「当前会话」code-agent 式改动：LLM 输出「变更清单」而非整页重写 ——

/** 生成器输出的单个变更动作：整文件覆盖（write）或精确替换（patch） */
export interface GeneratedToolChange {
  op: 'write' | 'patch'
  /** 工具目录内的相对文件名，白名单限 index.html / meta.json */
  file: string
  /** write：整文件内容（index.html 为字符串；meta.json 为 { name,title,description } 对象） */
  content?: unknown
  /** patch：需要被替换的精确查找串 */
  find?: string
  /** patch：查找串被替换成的目标串 */
  replace?: string
  /** patch：是否全局替换（默认 false，仅替换第一处） */
  replace_all?: boolean
}

/** 生成器对当前工具的一次整体改动描述 */
export interface GeneratedChangeList {
  summary: string
  actions: GeneratedToolChange[]
}

/** 允许被生成器修改的工具内文件白名单 */
const ALLOWED_TOOL_FILES = ['index.html', 'meta.json'] as const

/**
 * 从 LLM 回复中解析「变更清单」（summary + actions）。
 * 回复可能是「澄清追问 / 能力缺失说明」等普通文本，此时返回 null。
 * 解析成功但动作为空/非法时返回 { changes, warning }，由渲染层提示但保留原文。
 * 当契约 JSON 可解析但 actions 为空（LLM 在澄清追问而非改代码）时返回
 * { changes: null, summary }，供渲染层仅展示人性化 summary，避免直出原始 JSON。
 */
export function parseGeneratedChanges(
  content: string
):
  | { changes: GeneratedChangeList }
  | { changes: null; warning?: string; summary?: string } {
  if (!content) return { changes: null }
  const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  if (!cleaned) return { changes: null }
  const block = cleaned.match(/```json\s*([\s\S]*?)```/i)
  const jsonStr = (block ? block[1] : cleaned).trim()
  try {
    const obj = JSON.parse(jsonStr) as { summary?: unknown; actions?: unknown }
    if (!obj || typeof obj !== 'object') return { changes: null }
    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
    if (!Array.isArray(obj.actions) || obj.actions.length === 0) {
      return summary ? { changes: null, summary } : { changes: null }
    }

    const actions: GeneratedToolChange[] = []
    for (const raw of obj.actions) {
      if (!raw || typeof raw !== 'object') return { changes: null, warning: '存在非法变更项' }
      const item = raw as Record<string, unknown>
      const file = String(item.file ?? '')
      if (!ALLOWED_TOOL_FILES.includes(file as (typeof ALLOWED_TOOL_FILES)[number])) {
        return { changes: null, warning: `不允许修改文件：${file}` }
      }
      const op = item.op
      if (op !== 'write' && op !== 'patch') {
        return { changes: null, warning: `未知操作：${String(op)}` }
      }
      const action: GeneratedToolChange = {
        op,
        file,
        content: item.content,
        find: typeof item.find === 'string' ? item.find : undefined,
        replace: typeof item.replace === 'string' ? item.replace : undefined,
        replace_all: item.replace_all === true
      }
      if (op === 'write') {
        // meta.json 需要对象；index.html 需要可用的字符串
        if (file === 'index.html' && typeof item.content !== 'string') {
          return { changes: null, warning: 'index.html 需要字符串内容' }
        }
      } else {
        if (!action.find) return { changes: null, warning: 'patch 动作缺少 find' }
      }
      actions.push(action)
    }

    return { changes: { summary: String(obj.summary ?? ''), actions } }
  } catch {
    return { changes: null }
  }
}

/**
 * 从 LLM 回复中解析 JSON 信封（内含 html）。
 * 回复可能是「澄清追问 / 能力缺失说明」等普通文本，此时返回 null。
 * 若回复里含 ```json 代码块则优先生效，否则尝试整体当作 JSON。
 */
export function parseGeneratedTool(content: string): GeneratedToolDef | null {
  if (!content) return null
  // 推理模型在思考时可能输出 <think>...</think>（由主进程包裹下发），剥离后再解析 JSON 避免污染
  const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  if (!cleaned) return null
  const block = cleaned.match(/```json\s*([\s\S]*?)```/i)
  const jsonStr = (block ? block[1] : cleaned).trim()
  try {
    const obj = JSON.parse(jsonStr) as {
      name?: unknown
      title?: unknown
      description?: unknown
      html?: unknown
      capabilities?: unknown
    }
    if (!obj || typeof obj !== 'object') return null
    // 必须有一段可打开的完整 HTML
    if (typeof obj.html !== 'string' || !obj.html.trim()) return null

    return {
      name: String(obj.name ?? 'tool'),
      title: String(obj.title ?? '新工具'),
      description: String(obj.description ?? ''),
      html: obj.html.trim(),
      ...(Array.isArray(obj.capabilities) && obj.capabilities.length
        ? { capabilities: obj.capabilities.filter((c): c is string => typeof c === 'string') }
        : {})
    }
  } catch {
    return null
  }
}

/**
 * 提取 html 中调用的能力 id：cap.run('id', args) 或 window.cap.run('id', args)。
 * 用于能力覆盖预判与运行前校验。
 */
export function extractCapabilities(html: string): string[] {
  const ids = new Set<string>()
  const re = /(?:window\.)?cap\.run\(\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) ids.add(m[1])
  return [...ids]
}

/** 能力覆盖预判：对照当前能力清单，判断 html 用到的每个能力是否可运行 */
export function buildCoverage(def: GeneratedToolDef, caps: CapabilityItem[]): CoverageReport {
  const available = new Set(caps.map((c) => c.id))
  const used = extractCapabilities(def.html)
  const covered = used.filter((id) => available.has(id))
  const missing = used.filter((id) => !available.has(id))
  return { tool: def, covered, missing }
}
