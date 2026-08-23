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
}

export interface CoverageReport {
  tool: GeneratedToolDef
  /** html 中用到的、且现有能力可覆盖的能力 id */
  covered: string[]
  /** html 中用到的、但现有能力缺失的能力 id */
  missing: string[]
}

/**
 * 从 LLM 回复中解析 JSON 信封（内含 html）。
 * 回复可能是「澄清追问 / 能力缺失说明」等普通文本，此时返回 null。
 * 若回复里含 ```json 代码块则优先生效，否则尝试整体当作 JSON。
 */
export function parseGeneratedTool(content: string): GeneratedToolDef | null {
  if (!content) return null
  const block = content.match(/```json\s*([\s\S]*?)```/i)
  const jsonStr = (block ? block[1] : content).trim()
  try {
    const obj = JSON.parse(jsonStr) as {
      name?: unknown
      title?: unknown
      description?: unknown
      html?: unknown
    }
    if (!obj || typeof obj !== 'object') return null
    // 必须有一段可打开的完整 HTML
    if (typeof obj.html !== 'string' || !obj.html.trim()) return null

    return {
      name: String(obj.name ?? 'tool'),
      title: String(obj.title ?? '新工具'),
      description: String(obj.description ?? ''),
      html: obj.html.trim()
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
