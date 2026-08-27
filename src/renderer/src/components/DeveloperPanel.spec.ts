import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import DeveloperPanel from './DeveloperPanel.vue'
import type { AgentToolJsonSchema } from '../../../shared/types'

const agentToolsApiMock = { list: vi.fn() }

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

function stubApi(): void {
  agentToolsApiMock.list.mockResolvedValue(TOOLS)
  vi.stubGlobal('api', { agentTools: agentToolsApiMock })
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

  it('点击「查看参数 Schema」展开 JSON，再点收起', async () => {
    const wrapper = mount(DeveloperPanel)
    await flushPromises()

    // 展开前不渲染参数 JSON
    expect(wrapper.text()).not.toContain('"toolId"')
    // 第二个工具（agent_tools_open）的展开按钮
    const buttons = wrapper.findAll('button')
    await buttons[1]!.trigger('click')
    expect(wrapper.text()).toContain('"toolId"')
    await buttons[1]!.trigger('click')
    expect(wrapper.text()).not.toContain('"toolId"')
    wrapper.unmount()
  })

  it('接口异常时展示错误信息', async () => {
    agentToolsApiMock.list.mockRejectedValue(new Error('加载失败'))
    const wrapper = mount(DeveloperPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('加载失败')
    wrapper.unmount()
  })
})
