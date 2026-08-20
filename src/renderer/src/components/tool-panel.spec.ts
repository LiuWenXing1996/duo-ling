import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ToolPanel from './tool-panel.vue'

const toolsApiMock = {
  list: vi.fn(),
  run: vi.fn()
}

const echoMeta = {
  name: 'echo',
  description: '原样返回输入的文本',
  inputJsonSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: '要回显的文本' } },
    required: ['text']
  }
}

function stubApi(list: unknown[] = [echoMeta]) {
  toolsApiMock.list.mockResolvedValue(list)
  toolsApiMock.run.mockResolvedValue({ ok: true, output: { reply: 'hi' } })
  vi.stubGlobal('api', { tools: toolsApiMock })
}

beforeEach(() => {
  vi.clearAllMocks()
  stubApi()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function findButtonByText(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((btn) => btn.text().includes(text))
}

describe('ToolPanel', () => {
  it('挂载时拉取工具列表并渲染', async () => {
    const wrapper = mount(ToolPanel)
    await flushPromises()
    expect(toolsApiMock.list).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('echo')
    wrapper.unmount()
  })

  it('无工具时展示空提示', async () => {
    stubApi([])
    const wrapper = mount(ToolPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('暂无可用工具')
    wrapper.unmount()
  })

  it('选中工具后展示输入表单，填写并执行调用 api.tools.run', async () => {
    const wrapper = mount(ToolPanel)
    await flushPromises()
    await findButtonByText(wrapper, 'echo')!.trigger('click')
    await flushPromises()

    // 表单出现：输入框 + 执行按钮
    expect(wrapper.find('input[type="text"]').exists()).toBe(true)
    await wrapper.find('input[type="text"]').setValue('你好')
    await findButtonByText(wrapper, '执行')!.trigger('click')
    await flushPromises()

    expect(toolsApiMock.run).toHaveBeenCalledWith('echo', { text: '你好' })
    expect(wrapper.text()).toContain('"reply": "hi"')
    wrapper.unmount()
  })

  it('执行失败时展示错误信息', async () => {
    toolsApiMock.run.mockResolvedValue({ ok: false, error: '输入校验失败: xxx' })
    const wrapper = mount(ToolPanel)
    await flushPromises()
    await findButtonByText(wrapper, 'echo')!.trigger('click')
    await flushPromises()
    await wrapper.find('input[type="text"]').setValue('你好')
    await findButtonByText(wrapper, '执行')!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('输入校验失败')
    wrapper.unmount()
  })

  it('无输入参数的工具直接展示执行按钮', async () => {
    toolsApiMock.list.mockResolvedValue([
      { name: 'noop', description: '无参数工具', inputJsonSchema: { type: 'object', properties: {} } }
    ])
    const wrapper = mount(ToolPanel)
    await flushPromises()
    await findButtonByText(wrapper, 'noop')!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('该工具无需输入参数')
    await findButtonByText(wrapper, '执行')!.trigger('click')
    await flushPromises()
    expect(toolsApiMock.run).toHaveBeenCalledWith('noop', {})
    wrapper.unmount()
  })
})
