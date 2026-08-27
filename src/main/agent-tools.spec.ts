import { describe, expect, it, vi } from 'vitest'
import { buildAisdkTools, agentToolsToJsonSchema, executeAgentTool } from './agent-tools'
import { listCapabilities } from './capability-registry'

// agent-tools 经 tool-page 依赖 electron（userData 路径），打桩避免测试环境解析失败
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  shell: { openPath: vi.fn() }
}))

describe('agent-tools（Agent 工具定义与执行）', () => {
  it('buildAisdkTools 暴露四个 agent 工具，含查询能力清单', () => {
    const tools = buildAisdkTools()
    expect(Object.keys(tools).sort()).toEqual(
      ['agent_tools_list', 'agent_tools_open', 'agent_tools_create', 'agent_tools_lock_status', 'agent_capabilities_list'].sort()
    )
  })

  it('agent_capabilities_list 返回与 listCapabilities 一致的能力清单', async () => {
    const res = await executeAgentTool('agent_capabilities_list', '', {})
    expect(res.ok).toBe(true)
    const caps = JSON.parse((res as { result: string }).result) as Array<{ id: string }>
    expect(caps.map((c) => c.id)).toEqual(listCapabilities().map((c) => c.id))
  })

  it('未知工具名返回结构化错误而非抛出', async () => {
    const res = await executeAgentTool('agent_nonexistent', '{}', {})
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('未知工具')
  })

  it('agentToolsToJsonSchema 输出 OpenAI function 风格的 JSON Schema 且可序列化', () => {
    const tools = buildAisdkTools()
    const schemas = agentToolsToJsonSchema(tools)

    expect(schemas).toHaveLength(Object.keys(tools).length)
    for (const schema of schemas) {
      expect(schema.type).toBe('function')
      expect(schema.function.name).toBeTruthy()
      expect(schema.function.description).toBeTruthy()
      // 输入参数是纯 JSON Schema，可安全序列化（IPC 返回纯字面量）
      expect(() => JSON.stringify(schema.function.parameters)).not.toThrow()
      expect(schema.function.parameters.type).toBe('object')
    }
    // 名字与 buildAisdkTools 的 key 一一对应
    expect(schemas.map((s) => s.function.name).sort()).toEqual(Object.keys(tools).sort())
  })
})
