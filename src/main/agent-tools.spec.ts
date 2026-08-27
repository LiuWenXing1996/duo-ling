import { describe, expect, it, vi } from 'vitest'
import { buildAisdkTools, executeAgentTool } from './agent-tools'
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
})
