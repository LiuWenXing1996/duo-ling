import { z } from 'zod'

/**
 * 工具标准
 *
 * 每个工具 = 一个函数（同步/异步均可），输入输出均为 JS object：
 * - 输入：inputSchema 约束（空输入为 z.object({})）
 * - 输出：outputSchema 约束（空输出为 z.object({})）
 *
 * 两种使用模式：
 * - 无 UI：主进程内直接调用 runTool()，如被其他工具或 AI 流程调用
 * - UI 模式：inputSchema 转 JSON Schema 下发渲染层，自动生成表单让用户填写
 */

export interface Tool<In extends object = object, Out extends object = object> {
  /** 工具唯一标识（kebab-case） */
  name: string
  /** 人类可读描述，用于 UI 展示与 AI 理解 */
  description: string
  /** 输入 schema（ZodObject，保证输入为 object），空输入 = z.object({}) */
  inputSchema: z.ZodObject
  /** 输出 schema（ZodObject，保证输出为 object），空输出 = z.object({}) */
  outputSchema: z.ZodObject
  /** 执行函数，同步或异步 */
  run: (input: In) => Out | Promise<Out>
}

/** 统一注册/执行用的宽类型（运行时依赖的是 schema 而非具体 TS 类型） */
export type AnyTool = Tool<any, any>

/** 暴露给渲染层的工具元数据（纯 JSON，可结构化克隆，IPC 安全） */
export interface ToolMeta {
  name: string
  description: string
  /** 输入 schema 转换后的 JSON Schema，供表单生成 */
  inputJsonSchema: Record<string, unknown>
}

/** 工具执行结果（统一返回结构） */
export type ToolRunResult =
  | { ok: true; output: object }
  | { ok: false; error: string }
