// 原子能力契约（PRD §8.1）+ 前后端两个分域注册表（PRD §8.2）
//
// 契约七字段：id / name / description / inputSchema / outputSchema /
// sideEffect / runtime / cost / scenario。
// 登记来源（MVP 方案 A）：应用内置模块，代码硬编码能力清单。
// 执行形态：全部进程隔离 —— backend 跑 utilityProcess，frontend 注入工具界面（见 capability-worker / capability-runtime / 渲染层 runner）。

import type {
  Capability,
  CapabilityCost,
  CapabilityRuntime,
  CapabilitySchema,
  CapabilitySchemaField,
  CapabilityScenario,
  CapabilitySideEffect
} from '../shared/types'

export type {
  Capability,
  CapabilityCost,
  CapabilityRuntime,
  CapabilitySchema,
  CapabilitySchemaField,
  CapabilityScenario,
  CapabilitySideEffect
}

/** 主进程 ↔ capability-worker 的运行请求 */
export interface CapabilityRunRequest {
  requestId: string
  id: string
  args: unknown
}

/** capability-worker → 主进程 的响应 */
export type CapabilityRunResult =
  | { requestId: string; ok: true; result: unknown }
  | { requestId: string; ok: false; error: string }

/** backend 运行域能力（runtime: backend，进程化执行） */
export const backendCapabilities: Capability[] = [
  {
    id: 'local.file.read',
    name: '本地文件读取',
    description: '读取指定路径的本地文件内容',
    inputSchema: {
      type: 'object',
      description: '读取参数',
      fields: { path: { type: 'string', description: '文件绝对路径' } }
    },
    outputSchema: {
      type: 'object',
      description: '读取结果',
      fields: { content: { type: 'string', description: '文件文本内容' } }
    },
    sideEffect: 'read',
    runtime: 'backend',
    cost: 'offline',
    scenario: { keywords: ['读文件', '读取', '文件内容', '文本'], object: '本地文件' }
  }
]

/** frontend 运行域能力（runtime: frontend，注入白名单组件/方法，不跨进程） */
export const frontendCapabilities: Capability[] = [
  {
    id: 'docs.markdown.render',
    name: 'Markdown 渲染',
    description: '将 Markdown 字符串渲染为 HTML 预览',
    inputSchema: {
      type: 'object',
      description: '渲染参数',
      fields: { markdown: { type: 'markdown', description: 'Markdown 原文' } }
    },
    outputSchema: {
      type: 'object',
      description: '渲染结果',
      fields: { html: { type: 'string', description: 'HTML 预览' } }
    },
    sideEffect: 'read',
    runtime: 'frontend',
    cost: 'offline',
    scenario: { keywords: ['markdown', '预览', '渲染', 'md'], object: 'Markdown 文档' }
  }
]

/** 合并两个分域清单：供 capability:list 返回生成器可读的能力全集 */
export function listCapabilities(): Capability[] {
  return [...frontendCapabilities, ...backendCapabilities]
}
