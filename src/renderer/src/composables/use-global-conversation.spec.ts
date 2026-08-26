import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGlobalConversation } from './use-global-conversation'
import type { AgentEventData } from '../../../shared/types'

// 捕获 window.api.agent.onEvent 注册的监听器，用来在 send 期间模拟主进程推送的流式事件
let agentListener: ((e: AgentEventData) => void) | null = null

beforeEach(() => {
  agentListener = null
  Object.defineProperty(window, 'api', {
    value: {
      conversation: {
        create: vi.fn().mockResolvedValue({
          id: 'c1',
          title: '新会话',
          createdAt: '',
          lastMessageAt: ''
        }),
        list: vi.fn().mockResolvedValue([]),
        intents: vi.fn().mockResolvedValue([]),
        appendMessage: vi.fn().mockResolvedValue({ id: 'm1' }),
        applyIntents: vi.fn().mockResolvedValue({ ok: true, results: [] })
      },
      agent: {
        onEvent: vi.fn((fn) => {
          agentListener = fn
        }),
        offEvent: vi.fn(),
        abort: vi.fn(),
        // 模拟 Agent Loop：第 1 轮输出正文→调工具，第 2 轮输出最终正文
        send: vi.fn().mockImplementation(async () => {
          agentListener?.({ type: 'token', token: '我来帮你创建。' })
          agentListener?.({ type: 'tool_start', name: 'agent_tools_create', arguments: '{}' })
          agentListener?.({ type: 'tool_result', name: 'agent_tools_create', ok: true, result: '工具已创建' })
          agentListener?.({ type: 'token', token: '这是最终正文。' })
          return { ok: true, content: '这是最终正文。', reasoning: '' }
        })
      }
    },
    configurable: true
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).api
})

describe('useGlobalConversation.send（多轮 Agent 流式事件）', () => {
  it('中间轮正文从草稿抽出归入步骤，主气泡只保留最终一轮正文', async () => {
    const conv = useGlobalConversation()
    await conv.send('帮我创建一个工具')

    const ai = conv.messages.value[1]
    expect(ai.role).toBe('ai')
    // 主气泡只保留最终一轮正文（不再有多轮拼接的「断断续续」）
    expect(ai.content).toBe('这是最终正文。')
    // 中间轮正文归入对应步骤，并把该工具调用标记为完成
    expect(ai.steps).toHaveLength(1)
    expect(ai.steps?.[0].name).toBe('agent_tools_create')
    expect(ai.steps?.[0].content).toBe('我来帮你创建。')
    expect(ai.steps?.[0].status).toBe('done')
  })

  it('tool_start 归档本轮思考到 reasonings，send 结束收尾最终轮思考', async () => {
    // 覆写 send：第 1 轮思考→正文→调工具，第 2 轮思考→最终正文
    ;(window.api.agent.send as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      agentListener?.({ type: 'reasoning', text: '我先分析场景。' })
      agentListener?.({ type: 'token', token: '我来帮你创建。' })
      agentListener?.({ type: 'tool_start', name: 'agent_tools_create', arguments: '{}' })
      agentListener?.({ type: 'tool_result', name: 'agent_tools_create', ok: true, result: '工具已创建' })
      agentListener?.({ type: 'reasoning', text: '最终结论。' })
      agentListener?.({ type: 'token', token: '已创建完成。' })
      return { ok: true, content: '已创建完成。', reasoning: '最终结论。' }
    })
    const conv = useGlobalConversation()
    await conv.send('帮我创建一个工具')

    const ai = conv.messages.value[1]
    // tool_start 归档第 1 轮思考，send 结束收尾最终轮思考 → reasonings 按轮分批，不聚合
    expect(ai.reasonings).toEqual(['我先分析场景。', '最终结论。'])
    // 最终轮思考仍保留在 reasoning（历史回显回退用）
    expect(ai.reasoning).toBe('最终结论。')
    // 中间轮正文归入步骤卡，主气泡只保留最终一轮正文
    expect(ai.steps?.[0].content).toBe('我来帮你创建。')
    expect(ai.content).toBe('已创建完成。')
  })
})
