// 原子能力契约（PRD §8.1）+ 前后端两个分域注册表（PRD §8.2）
//
// 契约：id / name / description / inputSchema / outputSchema / sideEffect /
// runtime / cost / scenario。
// 登记来源（MVP 方案 A）：应用内置模块，代码硬编码能力清单。
// Schema 表达：注册表以 **zod 为唯一权威源**（CapabilityDefinition.inputSchema/
// outputSchema 为 zod），出 IPC/AI（capability:list / agent_capabilities_list）
// 时经 asSchema(zodSchema()) 序列化为标准 JSON Schema（纯字面量）。
// 运行时参数校验（capability:run 边界）也复用同一份 zod schema。
// 执行形态：全部进程隔离 —— backend 跑 utilityProcess，frontend 注入工具界面（见 capability-worker / capability-runtime / 渲染层 runner）。

import { z } from 'zod'
import { asSchema, zodSchema } from 'ai'
import type {
  Capability,
  CapabilityCost,
  CapabilityRuntime,
  CapabilityScenario,
  CapabilitySideEffect
} from '../shared/types'
import { toolsDataCapabilities } from './tools-data'

export type {
  Capability,
  CapabilityCost,
  CapabilityRuntime,
  CapabilityScenario,
  CapabilitySideEffect
}

/** 注册表内部权威定义：schema 为 zod，出 IPC/AI 时序列化为标准 JSON Schema */
export interface CapabilityDefinition extends Omit<Capability, 'inputSchema' | 'outputSchema'> {
  inputSchema: z.ZodType
  outputSchema: z.ZodType
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
export const backendCapabilityDefs: CapabilityDefinition[] = [
  {
    id: 'local.file.read',
    name: '本地文件读取',
    description: '读取指定路径的本地文件内容',
    inputSchema: z.object({
      path: z.string().describe('文件绝对路径')
    }),
    outputSchema: z.object({
      content: z.string().describe('文件文本内容')
    }),
    sideEffect: 'read',
    runtime: 'backend',
    cost: 'offline',
    scenario: { keywords: ['读文件', '读取', '文件内容', '文本'], object: '本地文件' }
  }
]

/** frontend 运行域能力（runtime: frontend，注入白名单组件/方法，不跨进程） */
export const frontendCapabilityDefs: CapabilityDefinition[] = [
  {
    id: 'docs.markdown.render',
    name: 'Markdown 渲染',
    description: '将 Markdown 字符串渲染为 HTML 预览',
    inputSchema: z.object({
      markdown: z.string().describe('Markdown 原文（语义类型: markdown）')
    }),
    outputSchema: z.object({
      html: z.string().describe('HTML 预览')
    }),
    sideEffect: 'read',
    runtime: 'frontend',
    cost: 'offline',
    scenario: { keywords: ['markdown', '预览', '渲染', 'md'], object: 'Markdown 文档' }
  },
  {
    id: 'tool.lock.status',
    name: '工具锁状态查询',
    description: '查询某个工具当前是否被其它会话只读锁定。只读，不修改任何状态；Phase 1 恒为未锁定。',
    inputSchema: z.object({
      toolId: z.string().describe('工具 id')
    }),
    outputSchema: z.object({
      locked: z.boolean().describe('是否被锁'),
      holderId: z.string().describe('持锁者（未锁时缺省）').optional()
    }),
    sideEffect: 'read',
    runtime: 'frontend',
    cost: 'offline',
    scenario: { keywords: ['锁', '锁定', '冲突', '占用', '编辑中'], object: '工具编辑锁' }
  }
]

/** 全部分域的 zod 权威定义（frontend + backend + 工具数据域） */
function allDefinitions(): CapabilityDefinition[] {
  return [...frontendCapabilityDefs, ...backendCapabilityDefs, ...toolsDataCapabilities]
}

/** zod → 标准 JSON Schema（纯字面量，供 capability:list / agent_capabilities_list 序列化） */
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return asSchema(zodSchema(schema)).jsonSchema as Record<string, unknown>
}

/** 合并全部分域清单：返回序列化后的能力全集（inputSchema/outputSchema 为标准 JSON Schema） */
export function listCapabilities(): Capability[] {
  return allDefinitions().map(({ inputSchema, outputSchema, ...rest }) => ({
    ...rest,
    inputSchema: toJsonSchema(inputSchema),
    outputSchema: toJsonSchema(outputSchema)
  }))
}

/** 按 id 取 zod 权威定义（capability:run 边界参数校验用） */
export function getCapabilityDefinition(id: string): CapabilityDefinition | undefined {
  return allDefinitions().find((c) => c.id === id)
}
