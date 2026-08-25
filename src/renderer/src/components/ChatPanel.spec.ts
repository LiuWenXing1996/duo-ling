import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatPanel from './ChatPanel.vue'
import type { PendingChange, ToolChatMessage } from '@/composables/use-tool-sessions'

// chat-panel 在 onMounted 中拉取模型列表，注入最小 window.api
beforeEach(() => {
  Object.defineProperty(window, 'api', {
    value: {
      model: {
        list: vi.fn().mockResolvedValue({ profiles: [], activeId: '' })
      }
    },
    configurable: true
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).api
})

const messages: ToolChatMessage[] = [
  { id: 'u1', role: 'user', content: '帮我重写这个工具' },
  { id: 'a1', role: 'ai', content: '已重写完成', reasoning: '先分析结构' }
]

const pending: PendingChange = {
  messageId: 'a1',
  changes: {
    summary: '重写该工具',
    actions: [{ op: 'patch', file: 'index.html', find: 'old text' }]
  }
}

function mountPanel(overrides: Record<string, unknown> = {}): ReturnType<typeof mount> {
  return mount(ChatPanel, {
    props: {
      messages,
      pendingMap: { a1: pending },
      streaming: false,
      draft: null,
      ...overrides
    }
  })
}

describe('ChatPanel 消息气泡（ai-elements 化）', () => {
  it('user 消息用 Message 渲染并带 is-user 结构', () => {
    const wrapper = mountPanel()
    expect(wrapper.find('.is-user').exists()).toBe(true)
    expect(wrapper.text()).toContain('帮我重写这个工具')
  })

  it('assistant 消息用 Message 渲染，正文经 MessageResponse 输出', () => {
    const wrapper = mountPanel()
    expect(wrapper.find('.is-assistant').exists()).toBe(true)
    expect(wrapper.text()).toContain('已重写完成')
  })

  it('思考过程默认折叠，点击后展开 think-body', async () => {
    const wrapper = mountPanel({ attachTo: document.body })
    const body = () => wrapper.find('[data-testid="think-body"]')
    // reka CollapsibleContent 默认关闭时保持挂载（unmountOnHide=false），
    // 仅以 hidden="until-found" + data-state="closed" 隐藏内容，而非卸载
    expect(body().exists()).toBe(true)
    expect(body().attributes('data-state')).toBe('closed')

    const toggle = wrapper
      .findAll('button')
      .find((b) => b.text().includes('思考过程'))!
    await toggle.trigger('click')
    await wrapper.vm.$nextTick()

    expect(body().attributes('data-state')).toBe('open')
    expect(body().text()).toContain('先分析结构')
  })

  it('完成后的普通 JSON / markdown 正文不再被误屏蔽为「正在思考…」', async () => {
    const wrapper = mountPanel({
      messages: [
        { id: 'u1', role: 'user', content: '给我一个 JSON 示例' },
        { id: 'a1', role: 'ai', content: '{"ok": true}' }
      ],
      draft: null,
      streaming: false
    })
    // 已完成的契约会被归一化为 summary；普通 JSON 答案应原样展示，而非永久遮挡
    expect(wrapper.text()).not.toContain('正在思考…')
    expect(wrapper.text()).toContain('ok')
  })

  it('变更清单留痕卡片保留，纯自动落盘展示（无应用/放弃按钮）', async () => {
    const wrapper = mountPanel()
    const card = wrapper.find('[data-testid="change-card"]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('重写该工具')
    // 纯自动落盘：无手动「应用/放弃」按钮，仅显示已自动应用状态
    expect(wrapper.findAll('button').some((b) => b.text().trim() === '应用')).toBe(false)
    expect(wrapper.findAll('button').some((b) => b.text().trim() === '放弃')).toBe(false)
    expect(card.text()).toContain('已自动应用到当前工具')
  })

  it('变更落盘失败时，留痕卡片展示错误信息', async () => {
    const wrapper = mountPanel({
      pendingMap: {
        a1: { ...pending, error: '写入工具失败' }
      }
    })
    const card = wrapper.find('[data-testid="change-card"]')
    expect(card.text()).toContain('写入工具失败')
    expect(wrapper.find('[data-testid="change-error"]').exists()).toBe(true)
  })
})
