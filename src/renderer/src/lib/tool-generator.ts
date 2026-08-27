// 生成器（PRD §6 生成期）的渲染层数据模型与解析逻辑。
//
// 当前架构采用「多工具编辑意图清单」式改动：LLM 输出 { intents: [{ toolId, summary, actions[] }] }，
// 一次可声明对多个工具的改动；渲染层负责解析这份清单并交由主进程逐工具落盘（conversation:applyIntents）。
//
// 关键：全程零模板编译、零 new Function / eval —— AI 产出即浏览器可解析的原生 HTML，天然通过 CSP。

import { isAllowedToolFile } from '../../../shared/tool-files'
import type { GeneratedIntent } from '../../../shared/types'

/** 生成器输出的单个变更动作：整文件覆盖（write）或精确替换（patch） */
export interface GeneratedToolChange {
  op: 'write' | 'patch'
  /** 工具目录内的相对文件路径，白名单限根级 index.html / meta.json / archive.md + js/ css/ assets/ 子目录 */
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

// 可写文件白名单见 src/shared/tool-files.ts（与主进程编辑链路、git 遍历保持一致）

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
      if (!isAllowedToolFile(file)) {
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
 * 从 LLM 回复中解析「多工具编辑意图清单」（{ intents: [{ toolId, summary, actions[] }] }）。
 * 回复可能是「澄清追问 / 能力缺失说明」等普通文本，此时返回 null。
 * 解析成功但某意图的 toolId 缺失/动作为空/非法时返回 { intents: null, warning }，由渲染层提示。
 * 当契约 JSON 可解析但 intents 为空（LLM 在澄清追问而非改代码）时返回
 * { intents: null, summary }，供渲染层仅展示人性化 summary，避免直出原始 JSON。
 */
export function parseGeneratedIntents(
  content: string
):
  | { intents: GeneratedIntent[] }
  | { intents: null; warning?: string; summary?: string } {
  if (!content) return { intents: null }
  const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  if (!cleaned) return { intents: null }
  const block = cleaned.match(/```json\s*([\s\S]*?)```/i)
  const jsonStr = (block ? block[1] : cleaned).trim()
  try {
    const obj = JSON.parse(jsonStr) as { intents?: unknown; summary?: unknown }
    if (!obj || typeof obj !== 'object') return { intents: null }
    if (!Array.isArray(obj.intents) || obj.intents.length === 0) {
      const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
      return summary ? { intents: null, summary } : { intents: null }
    }

    const intents: GeneratedIntent[] = []
    for (const raw of obj.intents) {
      if (!raw || typeof raw !== 'object') return { intents: null, warning: '存在非法意图项' }
      const item = raw as Record<string, unknown>
      const toolId = typeof item.toolId === 'string' ? item.toolId.trim() : ''
      if (!toolId) return { intents: null, warning: '缺少 toolId' }
      if (!Array.isArray(item.actions) || item.actions.length === 0) {
        return { intents: null, warning: `intent「${toolId}」缺少 actions` }
      }

      const actions: GeneratedToolChange[] = []
      for (const rawAction of item.actions) {
        if (!rawAction || typeof rawAction !== 'object') {
          return { intents: null, warning: '存在非法变更项' }
        }
        const a = rawAction as Record<string, unknown>
        const file = String(a.file ?? '')
        if (!isAllowedToolFile(file)) {
          return { intents: null, warning: `不允许修改文件：${file}` }
        }
        const op = a.op
        if (op !== 'write' && op !== 'patch') {
          return { intents: null, warning: `未知操作：${String(op)}` }
        }
        const action: GeneratedToolChange = {
          op,
          file,
          content: a.content,
          find: typeof a.find === 'string' ? a.find : undefined,
          replace: typeof a.replace === 'string' ? a.replace : undefined,
          replace_all: a.replace_all === true
        }
        if (op === 'write') {
          if (file === 'index.html' && typeof a.content !== 'string') {
            return { intents: null, warning: 'index.html 需要字符串内容' }
          }
        } else {
          if (!action.find) return { intents: null, warning: 'patch 动作缺少 find' }
        }
        actions.push(action)
      }

      intents.push({
        toolId,
        summary: typeof item.summary === 'string' ? item.summary.trim() : '',
        actions
      })
    }

    return { intents }
  } catch {
    return { intents: null }
  }
}
