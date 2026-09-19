// UI 组件测试：ChatDataPanel.vue（会话库落盘原始视图，只读调试面板）。
// mock conversation-store（IndexedDB 在 happy-dom 下不可用），验证：
// 会话列表渲染、选中拉消息、pageContext 落盘标记、原始 JSON 展开/收起。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { AssistantMessage, Conversation, UserMessage } from '@/shared/types'

const listConversations = vi.fn()
const listMessages = vi.fn()

vi.mock('@/lib/conversation-store', () => ({
  listConversations: (...args: unknown[]) => listConversations(...args),
  listMessages: (...args: unknown[]) => listMessages(...args),
}))

import ChatDataPanel from './ChatDataPanel.vue'

const conv = (id: string, title: string): Conversation => ({
  id,
  title,
  createdAt: '2026-09-17T10:00:00.000Z',
  lastMessageAt: '2026-09-17T10:05:00.000Z',
  totalTokens: 128,
})

// Message 按 role 判别（user 分支带 pageContext、assistant 分支带 usage），
// 造数据用两个 builder，避免 Partial<Message> 在联合上散不开
const msg = (overrides?: Partial<Omit<UserMessage, 'role'>>): UserMessage => ({
  id: 'm1',
  conversationId: 'c1',
  role: 'user',
  content: '把这个按钮改成红色',
  parts: [{ type: 'text', text: '把这个按钮改成红色' }],
  createdAt: '2026-09-17T10:01:00.000Z',
  ...overrides,
})

const aiMsg = (overrides?: Partial<Omit<AssistantMessage, 'role'>>): AssistantMessage => ({
  id: 'm2',
  conversationId: 'c1',
  role: 'assistant',
  content: '好的',
  parts: [{ type: 'text', text: '好的' }],
  createdAt: '2026-09-17T10:01:01.000Z',
  ...overrides,
})

const elementCtx = {
  pickedAt: 1,
  pageUrl: 'https://example.com',
  summary: {
    tag: 'button',
    classes: [],
    attrs: {},
    selectors: [{ selector: '#submit', hitCount: 1 }],
    textSample: '提交',
    htmlSample: '<button id="submit">提交</button>',
  },
  full: { attrs: {}, outerHTML: '<button id="submit">提交</button>', parentChain: [] },
}

function mountPanel() {
  return mount(ChatDataPanel)
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('ChatDataPanel', () => {
  it('渲染会话列表（标题 + token 概览）', async () => {
    listConversations.mockResolvedValue([conv('c1', '改按钮颜色')])
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.text()).toContain('改按钮颜色')
    expect(wrapper.text()).toContain('128 tokens')
  })

  it('选中会话后拉取并渲染消息；带 pageContext 的消息显示落盘标记', async () => {
    listConversations.mockResolvedValue([conv('c1', '改按钮颜色')])
    listMessages.mockResolvedValue([
      msg({ pageContext: { element: elementCtx } }),
      aiMsg({ usage: { totalTokens: 88 } }),
    ])
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.find('[data-testid="chat-data-conv-c1"]').trigger('click')
    await flushPromises()
    expect(listMessages).toHaveBeenCalledWith('c1')
    expect(wrapper.text()).toContain('把这个按钮改成红色')
    expect(wrapper.find('[data-testid="chat-data-page-context"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('已点选 <button>')
  })

  it('无 pageContext 的消息不显示落盘标记；原始 JSON 可展开收起', async () => {
    listConversations.mockResolvedValue([conv('c1', '改按钮颜色')])
    listMessages.mockResolvedValue([msg()])
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.find('[data-testid="chat-data-conv-c1"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="chat-data-page-context"]').exists()).toBe(false)

    const rawBtn = wrapper.find('[data-testid="chat-data-raw-m1"]')
    expect(wrapper.find('pre').exists()).toBe(false)
    await rawBtn.trigger('click')
    expect(wrapper.text()).toContain('"conversationId"')
    await rawBtn.trigger('click')
    expect(wrapper.find('pre').exists()).toBe(false)
  })

  it('选中会话被删除（刷新后不在列表）时清掉选中态', async () => {
    listConversations
      .mockResolvedValueOnce([conv('c1', '改按钮颜色')])
      .mockResolvedValueOnce([])
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.find('[data-testid="chat-data-conv-c1"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="chat-data-refresh"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('左侧选择一个会话')
  })
})
