// 生成器（PRD §6 生成期）的渲染层数据模型与解析逻辑。
//
// 生成器复用主进程的 LLM 流式管道（generator:send / generator:event），
// 由 LLM 基于能力清单生成一个「完整的前端组件」：template（Vue 模板）+ setup（组件逻辑），
// 运行时用 @vue/compiler-dom 把 template 编译成 render 函数，与 setup 组合成真实 Vue 组件。
// setup 里用 cap.run('能力id', 参数) 调取原子能力；此处负责解析这份定义、提取它依赖的能力 id 并做覆盖校验。

import type { CapabilityItem } from './capability-runner'

/** 由 LLM 生成的组件型工具定义 */
export interface GeneratedToolDef {
  /** kebab-case 唯一 id */
  name: string
  title: string
  description: string
  /** Vue 3 模板字符串（含输入框 / 按钮 / 布局 / 结果展示），运行时编译为 render 函数 */
  template: string
  /** 组件逻辑源码：export default function setup() { ... return { ... } }，用 cap.run('id', args) 调能力 */
  setup: string
}

export interface CoverageReport {
  tool: GeneratedToolDef
  /** setup 中用到的、且现有能力可覆盖的能力 id */
  covered: string[]
  /** setup 中用到的、但现有能力缺失的能力 id */
  missing: string[]
}

/**
 * 从 LLM 回复中解析 JSON 信封（内含 template + setup）。
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
      template?: unknown
      setup?: unknown
    }
    if (!obj || typeof obj !== 'object') return null
    // 必须同时有一段模板与一段组件逻辑源码
    if (typeof obj.template !== 'string' || !obj.template.trim()) return null
    if (typeof obj.setup !== 'string' || !obj.setup.trim()) return null

    return {
      name: String(obj.name ?? 'tool'),
      title: String(obj.title ?? '新工具'),
      description: String(obj.description ?? ''),
      template: obj.template.trim(),
      setup: obj.setup.trim()
    }
  } catch {
    return null
  }
}

/**
 * 提取源码（组件逻辑 / setup）中调用的能力 id：cap.run('id', args)。
 * 用于能力覆盖预判与运行前校验。
 */
export function extractCapabilities(source: string): string[] {
  const ids = new Set<string>()
  const re = /cap\.run\(['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) ids.add(m[1])
  return [...ids]
}

/** 能力覆盖预判：对照当前能力清单，判断 setup 用到的每个能力是否可运行 */
export function buildCoverage(def: GeneratedToolDef, caps: CapabilityItem[]): CoverageReport {
  const available = new Set(caps.map((c) => c.id))
  const used = extractCapabilities(def.setup)
  const covered = used.filter((id) => available.has(id))
  const missing = used.filter((id) => !available.has(id))
  return { tool: def, covered, missing }
}
