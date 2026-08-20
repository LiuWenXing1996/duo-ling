import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ChatPanel from './chat-panel.vue'

const llamaApiMock = {
  init: vi.fn(),
  getStatus: vi.fn(),
  checkModel: vi.fn()
}

beforeEach(() => {
  llamaApiMock.init.mockResolvedValue({
    state: 'ready',
    modelPath: '/mock/llm-models/MiniCPM5-1B-Q8_0.gguf',
    modelExists: true,
    gpu: 'metal'
  })
  vi.stubGlobal('api', { llama: llamaApiMock })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ChatPanel', () => {
  it('挂载时自动尝试加载模型并展示就绪状态', async () => {
    const wrapper = mount(ChatPanel, { attachTo: document.body })
    await flushPromises()

    expect(llamaApiMock.init).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('就绪')
    expect(wrapper.text()).toContain('metal')
    wrapper.unmount()
  })

  it('模型缺失时展示错误提示', async () => {
    llamaApiMock.init.mockResolvedValue({
      state: 'error',
      modelPath: '/mock/llm-models/MiniCPM5-1B-Q8_0.gguf',
      modelExists: false,
      error: '未找到模型文件，请将 MiniCPM5-1B-Q8_0.gguf 放入 llm-models/ 目录'
    })
    const wrapper = mount(ChatPanel, { attachTo: document.body })
    await flushPromises()

    expect(wrapper.text()).toContain('加载失败')
    expect(wrapper.text()).toContain('未找到模型文件')
    wrapper.unmount()
  })
})
