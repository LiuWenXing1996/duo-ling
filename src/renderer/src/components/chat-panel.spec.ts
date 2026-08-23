import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ChatPanel from './chat-panel.vue'

const modelApiMock = {
  list: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
  setActive: vi.fn(),
  test: vi.fn()
}

let chatEventCallback: ((payload: Record<string, unknown>) => void) | null = null

const createTaskMock = vi.fn()

const chatApiMock = {
  history: vi.fn(),
  send: vi.fn(),
  abort: vi.fn(),
  onEvent: vi.fn((cb: (payload: Record<string, unknown>) => void) => {
    chatEventCallback = cb
  }),
  offEvent: vi.fn()
}

// 默认已配置：存在一条默认模型且 baseUrl/model/apiKey 齐全
const CONFIGURED = {
  profiles: [
    {
      id: 'p1',
      name: 'DeepSeek',
      baseUrl: 'https://api.example.com/v1',
      model: 'deepseek-chat',
      hasApiKey: true
    }
  ],
  activeId: 'p1'
}

function stubApi(listData: Record<string, unknown> = CONFIGURED, history: unknown[] = []) {
  modelApiMock.list.mockResolvedValue(listData)
  modelApiMock.save.mockResolvedValue({})
  modelApiMock.delete.mockResolvedValue(undefined)
  modelApiMock.setActive.mockResolvedValue(undefined)
  modelApiMock.test.mockResolvedValue({ ok: true, models: ['deepseek-chat'] })
  chatApiMock.history.mockResolvedValue(history)
  chatApiMock.send.mockResolvedValue(null)
  chatApiMock.abort.mockResolvedValue(undefined)
  createTaskMock.mockResolvedValue({ id: 100, title: '新会话', createdAt: '2026-08-20' })
  chatEventCallback = null
  vi.stubGlobal('api', { model: modelApiMock, chat: chatApiMock, createTask: createTaskMock })
}

beforeEach(() => {
  vi.clearAllMocks()
  stubApi()
})

afterEach(() => {
  vi.unstubAllGlobals()
  chatEventCallback = null
})

// 在 jsdom 中点击原生按钮（弹窗内容被 Teleport 到 body，需直接操作 DOM）
function clickNativeButtonByText(text: string) {
  const button = [...document.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === text
  )
  expect(button, `未找到按钮：${text}`).toBeTruthy()
  ;(button as HTMLButtonElement).click()
}

describe('ChatPanel', () => {
  it('挂载时读取模型配置并订阅聊天事件', async () => {
    const wrapper = mount(ChatPanel, { attachTo: document.body })
    await flushPromises()

    expect(modelApiMock.list).toHaveBeenCalledTimes(1)
    expect(chatApiMock.onEvent).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('未选中会话，直接输入消息将自动新建')
    wrapper.unmount()
  })

  it('未配置时展示提示且不可发送，点击「添加模型」发出跳转设置事件', async () => {
    stubApi({ profiles: [], activeId: '' })
    const wrapper = mount(ChatPanel, { attachTo: document.body })
    await flushPromises()

    expect(wrapper.text()).toContain('未配置')
    expect(wrapper.text()).toContain('设置')
    const textarea = wrapper.find('textarea')
    expect(textarea.attributes('disabled')).toBeDefined()
    // 常驻下拉框未配置时显示「未配置」，点击展开弹出空态面板
    const trigger = wrapper.find('button[aria-label="切换模型"]')
    expect(trigger.exists()).toBe(true)
    expect(trigger.text()).toContain('未配置')
    await trigger.trigger('click')
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('未配置模型')
    })
    // 面板底部「添加模型」按钮跳转设置页
    clickNativeButtonByText('添加模型')
    expect(wrapper.emitted('openSettings')).toBeTruthy()
    wrapper.unmount()
  })

  it('通过下拉框切换模型：调用 setActive 并刷新列表', async () => {
    stubApi(
      {
        profiles: [
          {
            id: 'p1',
            name: 'DeepSeek',
            baseUrl: 'https://api.example.com/v1',
            model: 'deepseek-chat',
            hasApiKey: true
          },
          {
            id: 'p2',
            name: 'Qwen',
            baseUrl: 'https://dashscope.example.com/v1',
            model: 'qwen-plus',
            hasApiKey: true
          }
        ],
        activeId: 'p1'
      },
      []
    )
    const wrapper = mount(ChatPanel, { attachTo: document.body })
    await flushPromises()

    // 常驻下拉框触发按钮显示当前默认模型名
    const trigger = wrapper.find('button[aria-label="切换模型"]')
    expect(trigger.exists()).toBe(true)
    expect(trigger.text()).toContain('DeepSeek')

    await trigger.trigger('click')
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Qwen')
    })

    // 点击列表中的 Qwen 触发 setActive
    const qwen = [...document.querySelectorAll('button')].find((el) =>
      el.textContent?.includes('Qwen')
    )
    expect(qwen).toBeTruthy()
    ;(qwen as HTMLButtonElement).click()
    await flushPromises()

    expect(modelApiMock.setActive).toHaveBeenCalledWith('p2')
    // 切换后重新拉取列表刷新状态
    expect(modelApiMock.list).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('选中会话后通过 IPC 加载历史消息', async () => {
    stubApi(CONFIGURED, [
      { id: 1, role: 'user', content: '你好', createdAt: 't1' },
      { id: 2, role: 'assistant', content: '你好！有什么可以帮你？', createdAt: 't2' }
    ])
    const wrapper = mount(ChatPanel, { attachTo: document.body, props: { activeTaskId: 1 } })
    await flushPromises()

    expect(chatApiMock.history).toHaveBeenCalledWith(1)
    expect(wrapper.text()).toContain('你好！有什么可以帮你？')
    wrapper.unmount()
  })

  it('发送消息后流式更新草稿，完成后定型为最终回复', async () => {
    stubApi(CONFIGURED, [])
    const wrapper = mount(ChatPanel, { attachTo: document.body, props: { activeTaskId: 1 } })
    await flushPromises()

    await wrapper.find('textarea').setValue('你好')
    const sendButton = wrapper.findAll('button').find((b) => b.text().includes('发送'))
    expect(sendButton).toBeTruthy()
    await sendButton!.trigger('click')
    await flushPromises()

    expect(chatApiMock.send).toHaveBeenCalledWith(1, '你好')

    chatEventCallback?.({ type: 'token', taskId: 1, token: '你' })
    chatEventCallback?.({ type: 'token', taskId: 1, token: '好' })
    expect(wrapper.text()).toContain('你好')

    chatEventCallback?.({
      type: 'done',
      taskId: 1,
      message: { id: 99, role: 'assistant', content: '你好！', createdAt: 't3' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('你好！')
    // 生成结束后不再显示「停止」按钮
    expect(wrapper.text()).not.toContain('停止')
    wrapper.unmount()
  })

  it('输入框为多行 textarea，回车发送、Shift+回车换行不发送', async () => {
    stubApi(CONFIGURED, [])
    const wrapper = mount(ChatPanel, { attachTo: document.body, props: { activeTaskId: 1 } })
    await flushPromises()

    const textarea = wrapper.find('textarea')
    expect(textarea.exists()).toBe(true)
    // 带最小（3 行）/最大高度限制
    expect(textarea.classes()).toContain('min-h-[78px]')
    expect(textarea.classes()).toContain('max-h-32')
    expect(textarea.attributes('placeholder')).toContain('Shift+回车换行')
    // 输入框底部有工具栏：模型选择器 + 发送按钮（右对齐）
    const sendButton = wrapper.findAll('button').find((b) => b.text().includes('发送'))
    expect(sendButton).toBeTruthy()
    expect(sendButton!.element.parentElement!.className).toContain('flex')

    await textarea.setValue('第一行')
    // Shift+回车：只换行，不发送
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(chatApiMock.send).not.toHaveBeenCalled()
    // 单独回车：发送
    await textarea.trigger('keydown.enter')
    await flushPromises()
    expect(chatApiMock.send).toHaveBeenCalledWith(1, '第一行')
    wrapper.unmount()
  })

  it('助手消息展示可折叠的思考过程，默认收起', async () => {
    stubApi(CONFIGURED, [
      { id: 1, role: 'assistant', content: '<think>\n推理内容\n</think>\n这是答案', createdAt: 't' }
    ])
    const wrapper = mount(ChatPanel, { attachTo: document.body, props: { activeTaskId: 1 } })
    await flushPromises()

    expect(wrapper.text()).toContain('思考过程')
    expect(wrapper.text()).toContain('这是答案')

    const thinkBody = wrapper.find('[data-testid="think-body"]')
    expect(thinkBody.isVisible()).toBe(false)

    const toggle = wrapper.findAll('button').find((b) => b.text().includes('思考过程'))
    expect(toggle).toBeTruthy()
    await toggle!.trigger('click')
    await flushPromises()
    expect(thinkBody.isVisible()).toBe(true)
    expect(thinkBody.text()).toContain('推理内容')
    wrapper.unmount()
  })

  it('思考过程卡片与回复气泡分离展示', async () => {
    stubApi(CONFIGURED, [
      { id: 1, role: 'assistant', content: '<think>\n推理内容\n</think>\n这是答案', createdAt: 't' }
    ])
    const wrapper = mount(ChatPanel, { attachTo: document.body, props: { activeTaskId: 1 } })
    await flushPromises()

    const thinkBody = wrapper.find('[data-testid="think-body"]')
    expect(thinkBody.exists()).toBe(true)
    // 思考内容的容器（卡片）应包含「思考过程」按钮
    const thinkCard = thinkBody.element.parentElement!
    expect(thinkCard.textContent).toContain('思考过程')

    // 答案气泡：文本只有答案，不含思考按钮，且与思考卡片同属一个消息行（兄弟节点）
    const bubble = wrapper.findAll('div').find((el) => el.text().trim() === '这是答案')
    expect(bubble).toBeTruthy()
    expect(bubble!.text().trim()).toBe('这是答案')
    expect(bubble!.element.parentElement).toBe(thinkCard.parentElement)
    expect(thinkCard.contains(bubble!.element)).toBe(false)
    wrapper.unmount()
  })

  it('空思考内容（仅空白）不展示「思考过程」按钮', async () => {
    stubApi(CONFIGURED, [
      { id: 1, role: 'assistant', content: '<think>\n\n</think>\n这是答案', createdAt: 't' }
    ])
    const wrapper = mount(ChatPanel, { attachTo: document.body, props: { activeTaskId: 1 } })
    await flushPromises()

    expect(wrapper.text()).not.toContain('思考过程')
    expect(wrapper.text()).toContain('这是答案')
    expect(wrapper.find('[data-testid="think-body"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('未选中会话时发送消息自动新建会话并选中', async () => {
    stubApi(CONFIGURED, [])
    const wrapper = mount(ChatPanel, { attachTo: document.body })
    await flushPromises()

    await wrapper.find('textarea').setValue('你好')
    const sendButton = wrapper.findAll('button').find((b) => b.text().includes('发送'))
    expect(sendButton).toBeTruthy()
    await sendButton!.trigger('click')
    await flushPromises()

    expect(createTaskMock).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('select')).toEqual([[100]])
    expect(chatApiMock.send).toHaveBeenCalledWith(100, '你好')
    wrapper.unmount()
  })
})
