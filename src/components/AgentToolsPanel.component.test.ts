// UI 组件测试：AgentToolsPanel.vue 的两条核心语义。
//
// A. **契约来自静态目录**：左栏列的就是 catalog 的 6 个工具，选中即展示该工具的
//    description 原文（面板展示 = 模型所见，故断言的是 catalog 里那一句）。
// B. **轨迹来自会话库落盘**：assistant 消息 parts 里的 `tool-<name>` parts 被抽成轨迹行，
//    带状态（已完成 / 错误）；没有记录时给「会话库为空 / 无这条工具记录」的空态而不是白屏。
//
// 边界 mock：conversation-store（IDB 读侧）与 use-data-sync（变更订阅）——本面板是只读展示，
// 两者都不必真跑；Collapsible / Badge 用真实 shadcn 组件。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import AgentToolsPanel from './AgentToolsPanel.vue'
import { TOOL_DESCRIPTIONS } from '@/lib/agent-tools-catalog'
import type { Conversation, Message } from '@/shared/types'

const listConversations = vi.hoisted(() => vi.fn())
const listMessages = vi.hoisted(() => vi.fn())

vi.mock('@/lib/conversation-store', () => ({ listConversations, listMessages }))
vi.mock('@/composables/use-data-sync', () => ({ useDataSync: vi.fn() }))

const conversation: Conversation = {
  id: 'c-1',
  title: '改一下百度搜索结果的字号',
  createdAt: '2026-09-19T11:00:00.000Z',
  lastMessageAt: '2026-09-19T12:00:00.000Z',
}

/** 一条含两个工具调用的 assistant 消息（形状对齐 UIMessage.parts 的落盘实况，故整体断言） */
const message = {
  id: 'm-1',
  conversationId: 'c-1',
  role: 'assistant',
  content: '（模型未生成回复内容）',
  createdAt: '2026-09-19T12:00:00.000Z',
  parts: [
    {
      type: 'tool-script_apply',
      toolCallId: 'tc-1',
      state: 'output-available',
      input: { summary: '改字号', code: 'x' },
      output: { ok: true, bytes: 123 },
    },
    {
      type: 'tool-script_read',
      toolCallId: 'tc-2',
      state: 'output-error',
      input: { uuid: 'u-1' },
      errorText: '脚本不存在：u-1',
    },
  ],
} as unknown as Message

let wrapper: VueWrapper

async function mountPanel(): Promise<VueWrapper> {
  const w = mount(AgentToolsPanel)
  await flushPromises()
  await flushPromises()
  return w
}

afterEach(() => {
  wrapper?.unmount()
  vi.clearAllMocks()
})

describe('AgentToolsPanel', () => {
  it('左栏列出全部工具；契约默认收起，展开后展示 catalog 的 description 原文', async () => {
    listConversations.mockResolvedValue([conversation])
    listMessages.mockResolvedValue([])
    wrapper = await mountPanel()

    for (const name of ['script_spec', 'script_read', 'script_apply', 'element_read', 'page_snapshot', 'error_read']) {
      expect(wrapper.find(`[data-testid="agent-tools-select-${name}"]`).exists()).toBe(true)
    }

    await wrapper.find('[data-testid="agent-tools-select-script_apply"]').trigger('click')
    const contract = wrapper.find('[data-testid="agent-tools-contract"]')
    // 默认收起：只留标题行（作用 + 入参数）—— 入参表可能很长，展开会把下方调用轨迹顶出屏幕
    expect(contract.text()).toContain('整文件提交源码并立刻做语法检查')
    expect(contract.text()).not.toContain(TOOL_DESCRIPTIONS.script_apply.slice(0, 20))

    // 展开：description 原文与入参表（含必填标记）才渲染
    await wrapper.find('[data-testid="agent-tools-contract-toggle"]').trigger('click')
    await flushPromises()
    expect(contract.text()).toContain(TOOL_DESCRIPTIONS.script_apply.slice(0, 20))
    expect(contract.text()).toContain('updateUuid')
    expect(contract.text()).toContain('必填')
  })

  it('轨迹来自落盘的 tool parts：两条调用各成一行，带状态；计数进左栏', async () => {
    listConversations.mockResolvedValue([conversation])
    listMessages.mockResolvedValue([message])
    wrapper = await mountPanel()

    const rows = wrapper.findAll('[data-testid^="agent-tools-trace-"]')
    expect(rows).toHaveLength(2)
    const text = rows.map((r) => r.text()).join('\n')
    expect(text).toContain('已完成')
    expect(text).toContain('错误')
    // 会话标题与调用次数（「全部工具」项的计数）
    expect(wrapper.find('[data-testid="agent-tools-select-all"]').text()).toContain('2 次调用')
  })

  it('会话库为空：空态提示，不白屏', async () => {
    listConversations.mockResolvedValue([])
    listMessages.mockResolvedValue([])
    wrapper = await mountPanel()

    expect(wrapper.findAll('[data-testid^="agent-tools-trace-"]')).toHaveLength(0)
    expect(wrapper.text()).toContain('会话库为空')
  })
})
