import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAisdkTools, agentToolsToJsonSchema, executeAgentTool } from './agent-tools'
import { listCapabilities } from './capability-registry'

// agent-tools 经 tool-page 依赖 electron（userData 路径），打桩避免测试环境解析失败
const holder = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => holder.root },
  shell: { openPath: vi.fn() }
}))

describe('agent-tools（Agent 工具定义与执行）', () => {
  it('buildAisdkTools 暴露七个 agent 工具，含查询能力清单', () => {
    const tools = buildAisdkTools()
    expect(Object.keys(tools).sort()).toEqual(
      [
        'agent_tools_list',
        'agent_tools_open',
        'agent_tools_create',
        'agent_tools_read',
        'agent_tools_edit',
        'agent_tools_lock_status',
        'agent_capabilities_list'
      ].sort()
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

  describe('agent_tools_read / agent_tools_edit（目录结构读写链路）', () => {
    const root = join(tmpdir(), `duo-ling-agent-tools-${Date.now()}`)
    const tools = () => join(root, 'tools')

    beforeAll(() => {
      holder.root = root
      mkdirSync(join(tools(), 't-abc'), { recursive: true })
      writeFileSync(join(tools(), 't-abc', 'index.html'), '<h1>工具</h1>', 'utf8')
      writeFileSync(
        join(tools(), 't-abc', 'meta.json'),
        JSON.stringify({ id: 't-abc', title: '工具A' }),
        'utf8'
      )
    })
    afterAll(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('read 返回工具整树源码（文本 utf8）', async () => {
      const res = await executeAgentTool('agent_tools_read', JSON.stringify({ toolId: 't-abc' }), {})
      expect(res.ok).toBe(true)
      const data = JSON.parse((res as { result: string }).result) as {
        toolId: string
        title: string
        files: Array<{ path: string; content: string; encoding: string }>
      }
      expect(data.toolId).toBe('t-abc')
      expect(data.title).toBe('工具A')
      const html = data.files.find((f) => f.path === 'index.html')
      expect(html?.content).toBe('<h1>工具</h1>')
      expect(html?.encoding).toBe('utf8')
    })

    it('read 未找到工具返回错误', async () => {
      const res = await executeAgentTool('agent_tools_read', JSON.stringify({ toolId: 't-nope' }), {})
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toContain('未找到工具')
    })

    it('edit 写入子目录文件并落盘', async () => {
      const res = await executeAgentTool(
        'agent_tools_edit',
        JSON.stringify({
          toolId: 't-abc',
          summary: '加脚本',
          actions: [{ op: 'write', file: 'js/main.js', content: 'console.log(1)' }]
        }),
        {}
      )
      expect(res.ok).toBe(true)
      if (res.ok) {
        const data = JSON.parse((res as { result: string }).result) as { changedFiles: string[] }
        expect(data.changedFiles.some((f) => f.endsWith('js/main.js'))).toBe(true)
      }
      expect(readFileSync(join(tools(), 't-abc', 'js/main.js'), 'utf8')).toBe('console.log(1)')
    })

    it('edit 写 assets/ 二进制（base64）', async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
      const res = await executeAgentTool(
        'agent_tools_edit',
        JSON.stringify({
          toolId: 't-abc',
          summary: '加图',
          actions: [{ op: 'write', file: 'assets/logo.png', content: png.toString('base64') }]
        }),
        {}
      )
      expect(res.ok).toBe(true)
      const written = readFileSync(join(tools(), 't-abc', 'assets/logo.png'))
      expect(Buffer.compare(written, png)).toBe(0)
    })

    it('edit 越权路径被拒（不落盘）', async () => {
      const res = await executeAgentTool(
        'agent_tools_edit',
        JSON.stringify({
          toolId: 't-abc',
          summary: '越权',
          actions: [{ op: 'write', file: '.git/config', content: 'x' }]
        }),
        {}
      )
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toContain('不允许修改文件')
    })
  })
})
