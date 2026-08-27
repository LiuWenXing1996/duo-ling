import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import DeveloperPanel from './DeveloperPanel.vue'
import type { AgentToolJsonSchema, Capability } from '../../../shared/types'

const agentToolsApiMock = { list: vi.fn() }
const capabilityApiMock = { list: vi.fn() }

const TOOLS: AgentToolJsonSchema[] = [
  {
    type: 'function',
    function: {
      name: 'agent_tools_list',
      description: '列出所有已存在的工具。',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'agent_tools_open',
      description: '打开一个工具页。',
      parameters: {
        type: 'object',
        properties: { toolId: { type: 'string', description: '工具 id' } },
        required: ['toolId'],
        additionalProperties: false
      }
    }
  }
]

const CAPABILITIES: Capability[] = [
  {
    id: 'local.file.read',
    name: '本地文件读取',
    description: '读取指定路径的本地文件内容',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件绝对路径' } },
      required: ['path']
    },
    outputSchema: { type: 'object', properties: { content: { type: 'string' } } },
    sideEffect: 'read',
    runtime: 'backend',
    cost: 'offline',
    scenario: { keywords: ['读文件'], object: '本地文件' }
  },
  {
    id: 'docs.markdown.render',
    name: 'Markdown 渲染',
    description: '将 Markdown 字符串渲染为 HTML 预览',
    inputSchema: { type: 'object', properties: { markdown: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { html: { type: 'string' } } },
    sideEffect: 'read',
    runtime: 'frontend',
    cost: 'offline',
    scenario: { keywords: ['markdown'], object: 'Markdown 文档' }
  }
]

function stubApi(): void {
  agentToolsApiMock.list.mockResolvedValue(TOOLS)
  capabilityApiMock.list.mockResolvedValue(CAPABILITIES)
  vi.stubGlobal('api', {
    agentTools: agentToolsApiMock,
    capability: capabilityApiMock
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  stubApi()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DeveloperPanel', () => {
  it('加载并展示全部 Agent 工具的名称与描述', async () => {
    const wrapper = mount(DeveloperPanel)
    await flushPromises()

    expect(agentToolsApiMock.list).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('agent_tools_list')
    expect(wrapper.text()).toContain('agent_tools_open')
    expect(wrapper.text()).toContain('列出所有已存在的工具。')
    expect(wrapper.text()).toContain('打开一个工具页。')
    wrapper.unmount()
  })

  it('点击组头可折叠/展开 Agent 工具分组，且不影响原子能力分组', async () => {
    const wrapper = mount(DeveloperPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('agent_tools_list')

    const groupToggle = wrapper.find('button[aria-label="切换 Agent 工具分组"]')
    await groupToggle.trigger('click')
    expect(wrapper.text()).not.toContain('agent_tools_list')
    expect(wrapper.text()).toContain('local.file.read')

    await groupToggle.trigger('click')
    expect(wrapper.text()).toContain('agent_tools_list')
    wrapper.unmount()
  })

  it('点击「查看参数 Schema」展开 JSON，再点收起', async () => {
    const wrapper = mount(DeveloperPanel)
    await flushPromises()

    // 展开前不渲染参数 JSON
    expect(wrapper.text()).not.toContain('"toolId"')
    // 第二个工具（agent_tools_open）的「查看参数 Schema」按钮（按文本查找，组头按钮不计入）
    const toggles = wrapper.findAll('button').filter((b) => b.text().includes('查看参数 Schema'))
    await toggles[1]!.trigger('click')
    expect(wrapper.text()).toContain('"toolId"')
    await toggles[1]!.trigger('click')
    expect(wrapper.text()).not.toContain('"toolId"')
    wrapper.unmount()
  })

  it('展示原子能力的名称、描述与运行域徽标', async () => {
    const wrapper = mount(DeveloperPanel)
    await flushPromises()

    expect(capabilityApiMock.list).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('local.file.read')
    expect(wrapper.text()).toContain('docs.markdown.render')
    expect(wrapper.text()).toContain('读取指定路径的本地文件内容')
    expect(wrapper.text()).toContain('backend')
    expect(wrapper.text()).toContain('frontend')
    wrapper.unmount()
  })

  it('展开原子能力的输入/输出 Schema', async () => {
    const wrapper = mount(DeveloperPanel)
    await flushPromises()

    expect(wrapper.text()).not.toContain('"path"')
    // 能力卡片按钮位于 Agent 工具按钮之后：全部按钮中能力区第一个展开按钮
    const buttons = wrapper.findAll('button')
    const capToggle = buttons.find((b) => b.text().includes('查看输入/输出 Schema'))
    await capToggle!.trigger('click')
    expect(wrapper.text()).toContain('"path"')
    expect(wrapper.text()).toContain('输入')
    expect(wrapper.text()).toContain('输出')
    wrapper.unmount()
  })

  it('接口异常时展示错误信息', async () => {
    agentToolsApiMock.list.mockRejectedValue(new Error('工具加载失败'))
    capabilityApiMock.list.mockRejectedValue(new Error('能力加载失败'))
    const wrapper = mount(DeveloperPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('工具加载失败')
    expect(wrapper.text()).toContain('能力加载失败')
    wrapper.unmount()
  })
})
