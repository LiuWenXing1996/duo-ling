import type { AnyTool } from './types'

/** 工具注册表：name -> tool */
const tools = new Map<string, AnyTool>()

export function registerTool(tool: AnyTool): void {
  if (tools.has(tool.name)) {
    throw new Error(`工具名冲突: ${tool.name} 已注册`)
  }
  tools.set(tool.name, tool)
}

export function getTool(name: string): AnyTool | undefined {
  return tools.get(name)
}

export function listTools(): AnyTool[] {
  return [...tools.values()]
}
