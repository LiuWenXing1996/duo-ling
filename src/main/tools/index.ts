import { registerTool, getTool, listTools } from './registry'
import { toJsonSchema } from './json-schema'
import type { ToolMeta, ToolRunResult } from './types'
import { echoTool } from './tool-echo'

/**
 * 注册内置工具（新增工具：创建 src/main/tools/tool-<name>.ts 并在此注册）
 */
export function registerBuiltinTools(): void {
  registerTool(echoTool)
}

/**
 * 执行工具（无 UI 模式入口）：输入 → inputSchema 校验 → run → outputSchema 校验。
 * 校验失败返回 { ok: false, error }，不会抛出。
 */
export async function runTool(name: string, rawInput: unknown): Promise<ToolRunResult> {
  const tool = getTool(name)
  if (!tool) {
    return { ok: false, error: `未知工具: ${name}` }
  }

  const inputResult = tool.inputSchema.safeParse(rawInput ?? {})
  if (!inputResult.success) {
    return { ok: false, error: `输入校验失败: ${inputResult.error.message}` }
  }

  let rawOutput: object
  try {
    rawOutput = await tool.run(inputResult.data)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const outputResult = tool.outputSchema.safeParse(rawOutput)
  if (!outputResult.success) {
    return { ok: false, error: `输出校验失败: ${outputResult.error.message}` }
  }
  return { ok: true, output: outputResult.data }
}

/** 列出全部工具的元数据（含 JSON Schema），供渲染层生成表单 */
export function listToolMetas(): ToolMeta[] {
  return listTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputJsonSchema: toJsonSchema(tool.inputSchema)
  }))
}
