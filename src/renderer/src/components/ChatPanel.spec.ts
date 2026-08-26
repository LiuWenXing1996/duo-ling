import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatPanel from './ChatPanel.vue'
import type { PendingChange, ToolChatMessage } from '@/composables/use-global-conversation'

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

  it('思考与执行过程默认展开，链首含说明且显示 reasoning 文字', () => {
    const wrapper = mountPanel({ attachTo: document.body })
    const chain = wrapper.find('[data-testid="chain-of-thought"]')
    expect(chain.exists()).toBe(true)
    expect(chain.text()).toContain('思考与执行过程')
    expect(chain.text()).toContain('先分析结构')
    // ChainOfThought 默认展开：reka CollapsibleContent（unmountOnHide=false）
    // 展开时无 hidden 属性，折叠时隐藏为 hidden="until-found"（首帧 data-state 因动画保护为 undefined，故用 hidden 判断）
    const body = chain.find('[data-slot="collapsible-content"]')
    expect(body.exists()).toBe(true)
    expect(body.attributes('hidden')).toBeUndefined()
  })

  it('点击链首可折叠/展开思考与执行过程', async () => {
    const wrapper = mountPanel({ attachTo: document.body })
    const body = () =>
      wrapper.find('[data-testid="chain-of-thought"] [data-slot="collapsible-content"]')
    expect(body().exists()).toBe(true)
    expect(body().attributes('hidden')).toBeUndefined()

    const toggle = wrapper.findAll('button').find((b) => b.text().includes('思考与执行过程'))!
    await toggle.trigger('click')
    await wrapper.vm.$nextTick()
    expect(body().attributes('hidden')).toBeDefined()

    await toggle.trigger('click')
    await wrapper.vm.$nextTick()
    expect(body().attributes('hidden')).toBeUndefined()
  })

  it('Agent 工具调用步骤以 ChainOfThoughtStep 逐步渲染（running→active，error 示错）', () => {
    const wrapper = mountPanel({
      messages: [
        { id: 'u1', role: 'user', content: '帮我重写这个工具' },
        {
          id: 'a1',
          role: 'ai',
          content: '已重写完成',
          steps: [
            { id: 's1', name: 'agent_tools_list', arguments: '{"type":"all"}', status: 'done', result: '工具列表：MD 阅读器' },
            { id: 's2', name: 'agent_tools_open', arguments: '{"path":"index.html"}', status: 'running' },
            { id: 's3', name: 'agent_tools_bad', arguments: '', status: 'error', error: '打开失败' }
          ]
        }
      ]
    })
    const chain = wrapper.find('[data-testid="chain-of-thought"]')
    expect(chain.exists()).toBe(true)
    expect(chain.text()).toContain('查询工具列表')
    expect(chain.text()).toContain('打开工具')
    // running → active：展示加载动画
    expect(chain.find('.animate-spin').exists()).toBe(true)
    // done 用绿色对勾、error 用 destructive 图标 + 错误文案
    expect(chain.find('.text-green-600').exists()).toBe(true)
    expect(chain.find('.text-destructive').exists()).toBe(true)
    expect(chain.text()).toContain('打开失败')
    // 出参 result（无 error 时）展示在步骤默认 slot
    expect(chain.text()).toContain('工具列表：MD 阅读器')
  })

  it('中间轮正文归入步骤卡展示，不再拼进主气泡', () => {
    const wrapper = mountPanel({
      messages: [
        { id: 'u1', role: 'user', content: '创建一个工具' },
        {
          id: 'a1',
          role: 'ai',
          content: '已创建完成，这是最终正文。',
          steps: [
            {
              id: 's1',
              name: 'agent_tools_create',
              arguments: '{}',
              status: 'done',
              result: '工具已创建',
              content: '我来帮你创建它。'
            }
          ]
        }
      ]
    })
    const chain = wrapper.find('[data-testid="chain-of-thought"]')
    // 中间轮正文在步骤链内展示
    expect(chain.text()).toContain('我来帮你创建它。')
    // 主气泡只展示最终正文
    expect(wrapper.text()).toContain('已创建完成，这是最终正文。')
  })

  it('思考轮次与工具步骤按轮交错展示（reasonings 不聚合到链首）', () => {
    const wrapper = mountPanel({
      messages: [
        { id: 'u1', role: 'user', content: '创建一个工具' },
        {
          id: 'a1',
          role: 'ai',
          content: '已创建完成，这是最终正文。',
          reasonings: ['我先分析场景。', '最终结论。'],
          steps: [
            {
              id: 's1',
              name: 'agent_tools_create',
              arguments: '{}',
              status: 'done',
              result: '工具已创建',
              content: '我来帮你创建它。'
            }
          ]
        }
      ]
    })
    const chain = wrapper.find('[data-testid="chain-of-thought"]')
    // 每轮思考单独展示，不再只聚合在链首
    expect(chain.text()).toContain('我先分析场景。')
    expect(chain.text()).toContain('最终结论。')
    // 中间轮正文仍归入步骤卡
    expect(chain.text()).toContain('我来帮你创建它。')
    // 最终一轮思考应排在工具步骤之后（对应「按轮分批」的顺序，而非聚在链首）
    const chainText = chain.element.textContent ?? ''
    const stepIdx = chainText.indexOf('agent_tools_create')
    const finalThinkIdx = chainText.indexOf('最终结论。')
    expect(finalThinkIdx).toBeGreaterThan(stepIdx)
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
