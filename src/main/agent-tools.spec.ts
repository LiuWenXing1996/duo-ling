import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAgentTools,
  agentToolsToJsonSchema,
  setWorkspaceTabsState,
  type AgentTools,
  type AgentToolResult
} from './agent-tools'
import { listCapabilities } from './capability-registry'

// agent-tools 经 tool-page 依赖 electron（userData 路径），打桩避免测试环境解析失败
const holder = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => holder.root },
  shell: { openPath: vi.fn() }
}))

// AI SDK 工具 execute 签名为 (input, options) 且返回类型含 AsyncIterable 变体；测试统一取其 Promise 分支
async function exec<K extends keyof AgentTools>(
  name: K,
  input: unknown,
  tools: AgentTools = buildAgentTools()
): Promise<AgentToolResult> {
  return (await tools[name].execute(input as never, {} as never)) as AgentToolResult
}

describe('agent-tools（Agent 工具定义与执行）', () => {
  it('buildAgentTools 暴露九个 agent 工具，含查询能力清单与工具规范', () => {
    const tools = buildAgentTools()
    expect(Object.keys(tools).sort()).toEqual(
      [
        'agent_tools_list',
        'agent_tools_open',
        'agent_tools_create',
        'agent_tools_read',
        'agent_tools_edit',
        'agent_tools_lock_status',
        'agent_workspace_tabs',
        'agent_capabilities_list',
        'agent_tool_spec'
      ].sort()
    )
  })

  it('agent_capabilities_list 返回与 listCapabilities 一致的能力清单', async () => {
    const res = await exec('agent_capabilities_list', {})
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('应执行成功')
    const caps = res.result as Array<{ id: string }>
    expect(caps.map((c) => c.id)).toEqual(listCapabilities().map((c) => c.id))
  })

  it('agent_tool_spec 返回工具规范全文（含关键契约小节）', async () => {
    const res = await exec('agent_tool_spec', {})
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('应执行成功')
    const { toolSpec } = res.result as { toolSpec: string }
    // 非空长文本
    expect(toolSpec.length).toBeGreaterThan(1000)
    // 覆盖工具规范的关键契约点
    expect(toolSpec).toContain('# 工具规范（Tool Spec）')
    expect(toolSpec).toContain('## 3.2 文件结构')
    expect(toolSpec).toContain('## 6.4 安全红线')
    expect(toolSpec).toContain('## 7.2 生成检查清单')
  })

  it('agent_workspace_tabs 返回渲染层上报的 tab 快照与当前激活标签（含中文 kindLabel）', async () => {
    setWorkspaceTabsState({
      tabs: [
        { id: 'home', title: '主页', kind: 'home' },
        { id: 't-abc', title: 'PDF 合并器', kind: 'tool', icon: 'P' },
        { id: 'settings', title: '设置', kind: 'settings' }
      ],
      activeTabId: 't-abc'
    })
    const res = await exec('agent_workspace_tabs', {})
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('应执行成功')
    const data = res.result as {
      activeTab: { id: string; kind: string; kindLabel: string }
      tabs: Array<{ id: string; kind: string; kindLabel: string; icon?: string }>
    }
    expect(data.activeTab.id).toBe('t-abc')
    expect(data.activeTab.kindLabel).toBe('工具详情')
    expect(data.tabs).toHaveLength(3)
    expect(data.tabs[0]).toMatchObject({ id: 'home', kindLabel: '主页' })
    expect(data.tabs[1]).toMatchObject({ id: 't-abc', kindLabel: '工具详情', icon: 'P' })
    expect(data.tabs[2]).toMatchObject({ id: 'settings', kindLabel: '设置' })
  })

  it('agentToolsToJsonSchema 输出 OpenAI function 风格的 JSON Schema 且可序列化', () => {
    const tools = buildAgentTools()
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
    // 名字与 buildAgentTools 的 key 一一对应
    expect(schemas.map((s) => s.function.name).sort()).toEqual(Object.keys(tools).sort())
  })

  it('agentToolsToJsonSchema 为每个工具透传 outputSchema（结构与 execute 返回一致、可序列化）', () => {
    const schemas = agentToolsToJsonSchema(buildAgentTools())
    const byName = Object.fromEntries(schemas.map((s) => [s.function.name, s.function]))

    // 全部 9 个工具均配置了输出 Schema，且可序列化
    expect(Object.keys(byName)).toHaveLength(9)
    for (const fn of Object.values(byName)) {
      expect(fn.outputSchema).toBeTruthy()
      expect(() => JSON.stringify(fn.outputSchema)).not.toThrow()
    }

    // agent_tools_list：数组 + 每项字段说明
    const out = byName['agent_tools_list'].outputSchema as Record<string, unknown>
    expect(out.type).toBe('array')
    const items = (out.items ?? {}) as { properties?: Record<string, unknown> }
    expect(Object.keys(items.properties ?? {})).toEqual(['id', 'name', 'title', 'description'])

    // agent_tools_open：对象 + 输出字段
    const open = byName['agent_tools_open'].outputSchema as { properties?: Record<string, unknown> }
    expect(Object.keys(open.properties ?? {})).toEqual(['opened', 'toolId'])

    // agent_tool_spec：对象 + toolSpec 字段
    const spec = byName['agent_tool_spec'].outputSchema as { properties?: Record<string, unknown> }
    expect(Object.keys(spec.properties ?? {})).toEqual(['toolSpec'])
  })

  describe('agent_tools_open / read / edit（目录结构读写链路）', () => {
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

    it('open 打开已存在工具并触发 onOpenTool 副作用', async () => {
      const onOpenTool = vi.fn()
      const tools = buildAgentTools({ onOpenTool })
      const res = await exec('agent_tools_open', { toolId: 't-abc' }, tools)
      expect(res.ok).toBe(true)
      expect(onOpenTool).toHaveBeenCalledWith({ toolId: 't-abc', title: '工具A' })
      if (res.ok) expect(res.result).toEqual({ opened: '工具A', toolId: 't-abc' })
    })

    it('open 未找到工具返回错误', async () => {
      const res = await exec('agent_tools_open', { toolId: 't-nope' })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toContain('未找到工具')
    })

    it('read 返回工具整树源码（文本 utf8）', async () => {
      const res = await exec('agent_tools_read', { toolId: 't-abc' })
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('应执行成功')
      const data = res.result as {
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
      const res = await exec('agent_tools_read', { toolId: 't-nope' })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toContain('未找到工具')
    })

    it('edit 写入子目录文件并落盘', async () => {
      const res = await exec('agent_tools_edit', {
        toolId: 't-abc',
        summary: '加脚本',
        actions: [{ op: 'write', file: 'js/main.js', content: 'console.log(1)' }]
      })
      expect(res.ok).toBe(true)
      if (res.ok) {
        const data = res.result as { changedFiles: string[] }
        expect(data.changedFiles.some((f) => f.endsWith('js/main.js'))).toBe(true)
      }
      expect(readFileSync(join(tools(), 't-abc', 'js/main.js'), 'utf8')).toBe('console.log(1)')
    })

    it('edit 写 assets/ 二进制（base64）', async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
      const res = await exec('agent_tools_edit', {
        toolId: 't-abc',
        summary: '加图',
        actions: [{ op: 'write', file: 'assets/logo.png', content: png.toString('base64') }]
      })
      expect(res.ok).toBe(true)
      const written = readFileSync(join(tools(), 't-abc', 'assets/logo.png'))
      expect(Buffer.compare(written, png)).toBe(0)
    })

    it('edit 越权路径被拒（不落盘）', async () => {
      const res = await exec('agent_tools_edit', {
        toolId: 't-abc',
        summary: '越权',
        actions: [{ op: 'write', file: '.git/config', content: 'x' }]
      })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toContain('不允许修改文件')
    })
  })
})
