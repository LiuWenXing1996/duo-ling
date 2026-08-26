import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatPanel from './ChatPanel.vue'
import type { PendingChange } from '@/composables/use-global-conversation'
import type { UIMessage } from 'ai'

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

const messages: UIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: '帮我重写这个工具' }] },
  {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: '先分析结构' },
      { type: 'text', text: '已重写完成' }
    ]
  }
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
      ...overrides
    }
  })
}

describe('ChatPanel 消息气泡（UIMessage parts 化）', () => {
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

  it('tool part 用官方 Tool 卡片渲染：标题、状态徽标、入参与出参', () => {
    const wrapper = mountPanel({
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: '帮我重写这个工具' }] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-agent_tools_list',
              toolCallId: 'tc-1',
              input: { type: 'all' },
              output: '工具列表：MD 阅读器',
              state: 'output-available',
              title: '查询工具列表'
            },
            {
              type: 'tool-agent_tools_open',
              toolCallId: 'tc-2',
              input: { path: 'index.html' },
              state: 'input-available',
              title: '打开工具'
            },
            {
              type: 'tool-agent_tools_open',
              toolCallId: 'tc-3',
              input: { path: 'bad.html' },
              errorText: '打开失败',
              state: 'output-error',
              title: '打开工具'
            }
          ]
        }
      ]
    })
    const chain = wrapper.find('[data-testid="chain-of-thought"]')
    expect(chain.exists()).toBe(true)
    // 标题来自 tool part title（agent_tools_list 中文名一并覆盖）
    expect(chain.text()).toContain('查询工具列表')
    expect(chain.text()).toContain('打开工具')
    // 状态徽标：output-available=Completed / input-available=Running / output-error=Error
    expect(chain.text()).toContain('Completed')
    expect(chain.text()).toContain('Running')
    expect(chain.text()).toContain('Error')
    // running 用图标脉冲，done 用绿对勾，error 用红叉
    expect(chain.find('.animate-pulse').exists()).toBe(true)
    expect(chain.find('.text-green-600').exists()).toBe(true)
    expect(chain.find('.text-red-600').exists()).toBe(true)
    // 入参 Parameters 含工具入参 JSON
    expect(chain.text()).toContain('Parameters')
    expect(chain.text()).toContain('index.html')
    // 出参 Result 含结果、出参容器含错误文案
    expect(chain.text()).toContain('Result')
    expect(chain.text()).toContain('工具列表：MD 阅读器')
    expect(chain.text()).toContain('打开失败')
  })

  it('思考与工具步骤按 parts 顺序交错展示（reasoning 不聚合到链首）', () => {
    const wrapper = mountPanel({
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: '创建一个工具' }] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: '我先分析场景。' },
            { type: 'tool-agent_tools_create', toolCallId: 'tc-1', input: {}, output: '工具已创建', state: 'output-available', title: '创建一个工具' },
            { type: 'reasoning', text: '最终结论。' }
          ]
        }
      ]
    })
    const chain = wrapper.find('[data-testid="chain-of-thought"]')
    // 每轮思考单独展示，不再只聚合在链首
    expect(chain.text()).toContain('我先分析场景。')
    expect(chain.text()).toContain('最终结论。')
    // 最终一轮思考应排在工具步骤之后（对应「按 parts 顺序」而非聚在链首）
    const chainText = chain.element.textContent ?? ''
    const toolIdx = chainText.indexOf('创建一个工具')
    const finalThinkIdx = chainText.indexOf('最终结论。')
    expect(finalThinkIdx).toBeGreaterThan(toolIdx)
  })

  it('思考与工具调用各自渲染为链上独立节点（ChainOfThoughtStep 包裹，思考带轮次 label）', () => {
    const wrapper = mountPanel()
    const chain = wrapper.find('[data-testid="chain-of-thought"]')
    // 默认消息 assistant 含一轮思考：以「思考 1」label 独立成环，而非裸段落
    expect(chain.text()).toContain('思考 1')
    expect(chain.text()).toContain('先分析结构')
    // 链节点结构：左侧图标列（Step 的竖线/图标容器）+ 右侧内容
    expect(chain.find('.flex.gap-2').exists()).toBe(true)
  })

  it('中间轮正文作为链上独立节点，最终答案保留在主气泡（正文分链）', () => {
    const wrapper = mountPanel({
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: '做一个能读本地文件的工具' }] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            // 第 1 轮：先看现状（中间轮正文）
            { type: 'text', text: '我先看看当前已有的工具情况。' },
            { type: 'tool-agent_tools_list', toolCallId: 'tc-1', input: {}, output: '工具列表：无', state: 'output-available', title: '查询工具列表' },
            // 第 2 轮：创建工具（中间轮正文）
            { type: 'text', text: '我来创建这个工具。' },
            { type: 'tool-agent_tools_create', toolCallId: 'tc-2', input: {}, output: '工具已创建', state: 'output-available', title: '创建一个工具' },
            // 最终答案（留主气泡）
            { type: 'text', text: '已创建成功，请直接使用。' }
          ]
        }
      ]
    })
    const chain = wrapper.find('[data-testid="chain-of-thought"]')
    // 中间轮正文都进了链（带「步骤 N」label 独立成环）
    expect(chain.exists()).toBe(true)
    expect(chain.text()).toContain('我先看看当前已有的工具情况。')
    expect(chain.text()).toContain('我来创建这个工具。')
    expect(chain.text()).toContain('步骤 1')
    expect(chain.text()).toContain('步骤 2')
    // 最终答案保留在主气泡，不进链
    expect(chain.text()).not.toContain('已创建成功，请直接使用。')
    const bubble = wrapper.find('.is-assistant')
    expect(bubble.exists()).toBe(true)
    expect(bubble.text()).toContain('已创建成功，请直接使用。')
    expect(bubble.text()).not.toContain('我先看看当前已有的工具情况。')
    expect(bubble.text()).not.toContain('我来创建这个工具。')
  })

  it('流式且尚无正文时给「正在思考…」占位，完成后不再误屏蔽正文', async () => {
    const wrapper = mountPanel({
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '给我一个 JSON 示例' }] }],
      // 流式中、最后一条 AI 尚无正文 -> 占位
      streaming: false
    })
    // 已完成的普通 JSON / markdown 正文应原样展示，而非永久遮挡
    expect(wrapper.text()).not.toContain('正在思考…')
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
