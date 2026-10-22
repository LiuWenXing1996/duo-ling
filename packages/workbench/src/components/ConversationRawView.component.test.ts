// UI 组件测试：ConversationRawView.vue（会话库落盘原始视图，只读调试）。
// mock conversation-store（IndexedDB 在 happy-dom 下不可用），验证：
// 挂载即拉取选中会话的消息、pageContext 落盘标记、原始 JSON 展开/收起、
// 选中会话切换时重拉并重置展开、无选中时空态。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { AssistantMessage, Conversation, UserMessage } from '@duoling/shared'

const listMessages = vi.fn()

// mock 落在包根：shared 是单包，spread 保其余符号真身
vi.mock('@duoling/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@duoling/shared')>()),
  listMessages: (...args: unknown[]) => listMessages(...args),
}))
vi.mock('@duoling/ui/composables/use-data-sync', () => ({
  useDataSync: vi.fn(),
  useDbSignal: vi.fn(),
}))

import ConversationRawView from './ConversationRawView.vue'

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

function mountView(conversation: Conversation | null = conv('c1', '改按钮颜色')) {
  return mount(ConversationRawView, { props: { conversation } })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('ConversationRawView', () => {
  it('挂载即拉取选中会话的消息；带 pageContext 的消息显示落盘标记', async () => {
    listMessages.mockResolvedValue([
      msg({ pageContext: { element: elementCtx } }),
      aiMsg({ usage: { totalTokens: 88 } }),
    ])
    const wrapper = mountView()
    await flushPromises()
    expect(listMessages).toHaveBeenCalledWith('c1')
    expect(wrapper.text()).toContain('把这个按钮改成红色')
    expect(wrapper.find('[data-testid="conv-raw-page-context"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('已点选 <button>')
  })

  it('无 pageContext 的消息不显示落盘标记；原始 JSON 可展开收起', async () => {
    listMessages.mockResolvedValue([msg()])
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-testid="conv-raw-page-context"]').exists()).toBe(false)

    const rawBtn = wrapper.find('[data-testid="conv-raw-raw-m1"]')
    expect(wrapper.find('pre').exists()).toBe(false)
    await rawBtn.trigger('click')
    expect(wrapper.text()).toContain('"conversationId"')
    await rawBtn.trigger('click')
    expect(wrapper.find('pre').exists()).toBe(false)
  })

  it('选中会话切换：换会话重拉消息，展开态一并重置', async () => {
    listMessages.mockResolvedValue([msg()])
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('[data-testid="conv-raw-raw-m1"]').trigger('click')
    expect(wrapper.find('pre').exists()).toBe(true)

    listMessages.mockResolvedValueOnce([aiMsg()])
    await wrapper.setProps({ conversation: conv('c2', '另一条会话') })
    await flushPromises()
    expect(listMessages).toHaveBeenLastCalledWith('c2')
    expect(wrapper.find('pre').exists()).toBe(false)
    expect(wrapper.text()).toContain('好的')
  })

  it('未选中会话：空态，不发起读取', async () => {
    const wrapper = mountView(null)
    await flushPromises()
    expect(listMessages).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('未选中会话')
  })

  it('手动刷新：重拉当前会话的消息', async () => {
    listMessages.mockResolvedValue([msg()])
    const wrapper = mountView()
    await flushPromises()

    listMessages.mockResolvedValueOnce([msg({ id: 'm3', content: '最新落盘' })])
    await wrapper.find('[data-testid="conv-raw-refresh"]').trigger('click')
    await flushPromises()
    expect(listMessages).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('最新落盘')
  })
})
