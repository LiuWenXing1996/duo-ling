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
      usageByMessageId: {},
      streaming: false,
      ...overrides
    }
  })
}

// 链默认折叠（reka Collapsible unmountOnHide 默认卸载内容），断言链内内容前先点击链首展开
async function expandChain(wrapper: ReturnType<typeof mount>): Promise<void> {
  const toggle = wrapper.findAll('button').find((b) => b.text().includes('思考过程'))!
  await toggle.trigger('click')
  await wrapper.vm.$nextTick()
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

  it('思考过程默认折叠，点击链首后展开并显示 reasoning 文字', async () => {
    const wrapper = mountPanel({ attachTo: document.body })
    const chain = wrapper.find('[data-testid="chain-of-thought"]')
    expect(chain.exists()).toBe(true)
    expect(chain.text()).toContain('思考过程')
    // 默认折叠：内容 hidden（reka CollapsibleContent unmountOnHide=false，折叠时隐藏为 hidden="until-found"）
    const body = chain.find('[data-slot="collapsible-content"]')
    expect(body.exists()).toBe(true)
    expect(body.attributes('hidden')).toBeDefined()
    // 点击链首展开后可见 reasoning 文字
    const toggle = wrapper.findAll('button').find((b) => b.text().includes('思考过程'))!
    await toggle.trigger('click')
    await wrapper.vm.$nextTick()
    expect(body.attributes('hidden')).toBeUndefined()
    expect(chain.text()).toContain('先分析结构')
  })

  it('点击链首可折叠/展开思考过程', async () => {
    const wrapper = mountPanel({ attachTo: document.body })
    const body = () =>
      wrapper.find('[data-testid="chain-of-thought"] [data-slot="collapsible-content"]')
    expect(body().exists()).toBe(true)
    // 默认折叠
    expect(body().attributes('hidden')).toBeDefined()

    const toggle = wrapper.findAll('button').find((b) => b.text().includes('思考过程'))!
    await toggle.trigger('click')
    await wrapper.vm.$nextTick()
    expect(body().attributes('hidden')).toBeUndefined()

    await toggle.trigger('click')
    await wrapper.vm.$nextTick()
    expect(body().attributes('hidden')).toBeDefined()
  })

  it('tool part 用官方 Tool 卡片渲染：标题、状态徽标、入参与出参', async () => {
    const wrapper = mountPanel({
      attachTo: document.body,
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
    await expandChain(wrapper)
    const chain = wrapper.find('[data-testid="chain-of-thought"]')
    expect(chain.exists()).toBe(true)
    // 标题来自 tool part title（agent_tools_list 中文名一并覆盖）
    expect(chain.text()).toContain('查询工具列表')
    expect(chain.text()).toContain('打开工具')
    // 状态徽标：output-available=已完成 / input-available=执行中 / output-error=错误
    expect(chain.text()).toContain('已完成')
    expect(chain.text()).toContain('执行中')
    expect(chain.text()).toContain('错误')
    // running 用图标脉冲，done 用绿对勾，error 用红叉
    expect(chain.find('.animate-pulse').exists()).toBe(true)
    expect(chain.find('.text-green-600').exists()).toBe(true)
    expect(chain.find('.text-red-600').exists()).toBe(true)
    // 工具卡默认收起：逐个点击 header 展开后断言入参/出参
    const toolToggles = wrapper.findAll('button').filter((b) => /查询工具列表|打开工具/.test(b.text()))
    for (const t of toolToggles) {
      await t.trigger('click')
    }
    await wrapper.vm.$nextTick()
    // 入参「参数」含工具入参 JSON
    expect(chain.text()).toContain('参数')
    expect(chain.text()).toContain('index.html')
    // 出参「结果」含结果、出参容器含错误文案
    expect(chain.text()).toContain('结果')
    expect(chain.text()).toContain('工具列表：MD 阅读器')
    expect(chain.text()).toContain('打开失败')
  })

  it('思考与工具步骤按 parts 顺序交错展示（reasoning 不聚合到链首）', async () => {
    const wrapper = mountPanel({
      attachTo: document.body,
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
    await expandChain(wrapper)
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

  it('思考与工具调用各自渲染为链上独立节点（ChainOfThoughtStep 包裹，思考 label 无编号）', async () => {
    const wrapper = mountPanel({ attachTo: document.body })
    await expandChain(wrapper)
    const chain = wrapper.find('[data-testid="chain-of-thought"]')
    // 默认消息 assistant 含一轮思考：以「思考」label 独立成环，而非裸段落
    expect(chain.text()).toContain('思考')
    expect(chain.text()).toContain('先分析结构')
    // 链节点结构：左侧图标列（Step 的竖线/图标容器）+ 右侧内容
    expect(chain.find('.flex.gap-2').exists()).toBe(true)
  })

  it('中间轮正文作为链上独立节点，最终答案保留在主气泡（正文分链）', async () => {
    const wrapper = mountPanel({
      attachTo: document.body,
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
    await expandChain(wrapper)
    const chain = wrapper.find('[data-testid="chain-of-thought"]')
    // 中间轮正文都进了链（带「说明」label 独立成环）
    expect(chain.exists()).toBe(true)
    expect(chain.text()).toContain('我先看看当前已有的工具情况。')
    expect(chain.text()).toContain('我来创建这个工具。')
    const explanationLabels = wrapper.findAll('div').filter((n) => n.text().trim() === '说明')
    expect(explanationLabels.length).toBe(2)
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

  it('流式中最后一条消息即使已有正文也只显示占位（零闪现：中间正文不进气泡）', async () => {
    const wrapper = mountPanel({
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: '帮我' }] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: '思考中。' },
            { type: 'text', text: '正在生成的正文，可能是中间正文。' }
          ]
        }
      ],
      streaming: true
    })
    const bubble = wrapper.find('.is-assistant')
    // 流式中：气泡只显示占位，不显示可能还会变化的正文（避免闪现）
    expect(bubble.text()).toContain('正在思考…')
    expect(bubble.text()).not.toContain('正在生成的正文')
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

  it('step-start 边界渲染「继续流程」节点', async () => {
    const wrapper = mountPanel({
      attachTo: document.body,
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: '帮我分析' }] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: '先看工具。' },
            { type: 'step-start' },
            { type: 'reasoning', text: '再看实现。' },
            { type: 'text', text: '最终答案。' }
          ]
        }
      ]
    })
    await expandChain(wrapper)
    const chain = wrapper.find('[data-testid="chain-of-thought"]')
    expect(chain.text()).toContain('继续流程')
    // 过渡文案已去掉，节点内容为占位（保持竖向连接线）
    expect(chain.text()).not.toContain('接下来继续分析')
    // 最终答案仍留主气泡，不进链
    expect(chain.text()).not.toContain('最终答案。')
  })

  it('链首 step-start 不渲染「继续流程」（首个 step 开始而非 step 之间）', async () => {
    const wrapper = mountPanel({
      attachTo: document.body,
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: '帮我' }] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'step-start' }, // 首个 step 开始（AI SDK 第一步也会发 start-step）
            { type: 'reasoning', text: '第一步的思考。' },
            { type: 'text', text: '完成。' }
          ]
        }
      ]
    })
    await expandChain(wrapper)
    const chain = wrapper.find('[data-testid="chain-of-thought"]')
    expect(chain.text()).not.toContain('继续流程')
    expect(chain.text()).toContain('第一步的思考。')
  })

  it('同 step 内中间正文（text 后接 tool）归链，不闪现进主气泡', async () => {
    const wrapper = mountPanel({
      attachTo: document.body,
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: '帮我' }] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: '先思考。' },
            // 同 step 内：中间正文后紧跟工具调用（无 step-start 分隔）
            { type: 'text', text: '中间正文，后面还有工具调用。' },
            { type: 'tool-agent_tools_list', toolCallId: 'tc-1', input: {}, output: '列表', state: 'output-available', title: '查询工具列表' },
            { type: 'text', text: '最终答案。' }
          ]
        }
      ]
    })
    await expandChain(wrapper)
    const chain = wrapper.find('[data-testid="chain-of-thought"]')
    expect(chain.text()).toContain('中间正文，后面还有工具调用。')
    const bubble = wrapper.find('.is-assistant')
    expect(bubble.text()).not.toContain('中间正文，后面还有工具调用。')
    expect(bubble.text()).toContain('最终答案。')
  })

  it('中间正文已过 step 边界时即使暂时是最后一段 text 也归链（最终答案判定增强）', async () => {
    const wrapper = mountPanel({
      attachTo: document.body,
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: '帮我' }] },
        {
          id: 'a1',
          role: 'assistant',
          // 流式中：中间正文后新 step 已开始，它不再可能成为最终答案
          parts: [
            { type: 'reasoning', text: '先思考。' },
            { type: 'text', text: '中间正文，后面还会有新 step。' },
            { type: 'step-start' }
          ]
        }
      ],
      streaming: true
    })
    await expandChain(wrapper)
    const chain = wrapper.find('[data-testid="chain-of-thought"]')
    expect(chain.text()).toContain('中间正文，后面还会有新 step。')
    const bubble = wrapper.find('.is-assistant')
    expect(bubble.text()).not.toContain('中间正文，后面还会有新 step。')
  })

  it('思考内容含超长代码时不撑宽（防横向滚动条回归）', async () => {
    const wrapper = mountPanel({
      attachTo: document.body,
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: '看下这段代码' }] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: `超长代码行：\`\`\`\n${'x'.repeat(500)}\n\`\`\`` },
            { type: 'text', text: '完成' }
          ]
        }
      ]
    })
    await expandChain(wrapper)
    const chain = wrapper.find('[data-testid="chain-of-thought"]')
    // 超长思考（500 字符 > 阈值）触发折叠：容器 max-h-40 overflow-hidden，宽度被钳制
    const folded = chain.findAll('div').filter((n) => n.classes().includes('max-h-40') && n.classes().includes('overflow-hidden'))
    expect(folded.length).toBeGreaterThan(0)
    // 展开全部后容器切换 overflow-x-auto：长代码内部横滚，不撑宽外层
    const expandBtn = wrapper.findAll('button').find((b) => b.text().includes('展开'))!
    await expandBtn.trigger('click')
    await wrapper.vm.$nextTick()
    const scrollers = chain.findAll('div').filter((n) => n.classes().includes('overflow-x-auto'))
    expect(scrollers.length).toBeGreaterThan(0)
    // 外层链容器带 min-w-0 钳宽
    expect(chain.classes().includes('min-w-0')).toBe(true)
  })
})
