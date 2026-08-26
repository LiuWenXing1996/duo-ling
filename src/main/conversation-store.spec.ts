import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addIntent,
  appendMessage,
  createConversation,
  getConversation,
  listConversations,
  listIntents,
  listMessages,
  renameConversation,
  setIntentStatus
} from './conversation-store'

// 与 online-llm.spec.ts 一致：electron-store 用内存对象打桩，规避测试环境对文件系统/electron 的依赖
let memory: Record<string, unknown> = {}

vi.mock('electron-store', () => {
  class MockStore {
    constructor(options: { defaults?: Record<string, unknown> }) {
      memory = { ...(options.defaults ?? {}) }
    }
    set(key: string, value: unknown) {
      memory[key] = value
    }
    get(key: string) {
      return memory[key]
    }
  }
  return { __esModule: true, default: MockStore }
})

beforeEach(() => {
  // 与 electron-store 默认值保持一致，避免缓存实例读到的字段为 undefined
  memory = { conversations: [], nextSeq: 1, messages: {}, intents: {} }
})

describe('conversation-store（会话/消息/EditIntent 存储）', () => {
  it('createConversation 自增序号生成标题「新会话 N」并落库', () => {
    const a = createConversation()
    const b = createConversation()
    expect(a.title).toBe('新会话 1')
    expect(b.title).toBe('新会话 2')
    expect(getConversation(a.id)?.id).toBe(a.id)
    expect(listConversations()).toHaveLength(2)
  })

  it('appendMessage 追加消息并刷新会话 lastMessageAt', () => {
    const c = createConversation()
    const m = appendMessage(c.id, 'user', '需求')
    expect(m).not.toBeNull()
    expect(m?.role).toBe('user')
    expect(m?.conversationId).toBe(c.id)
    expect(listMessages(c.id)).toHaveLength(1)
    const after = getConversation(c.id)
    expect(after).not.toBeNull()
    expect(after!.lastMessageAt >= c.lastMessageAt).toBe(true)
  })

  it('appendMessage 对不存在的会话返回 null', () => {
    expect(appendMessage('nope', 'user', 'x')).toBeNull()
  })

  it('renameConversation 去空白并更新标题；空标题 / 不存在返回 null', () => {
    const c = createConversation()
    expect(renameConversation(c.id, '  重命名  ')?.title).toBe('重命名')
    expect(renameConversation(c.id, '   ')).toBeNull()
    expect(renameConversation('nope', '改标题')).toBeNull()
  })

  it('addIntent 登记意图，listIntents 按 messageId 取出', () => {
    const c = createConversation()
    const m = appendMessage(c.id, 'assistant', 'ok')!
    const intent = addIntent(m.id, 'tool-a', '改标题', [
      { op: 'write', file: 'index.html', content: '<h1>x</h1>' }
    ])
    expect(intent.status).toBe('pending')
    const list = listIntents(m.id)
    expect(list).toHaveLength(1)
    expect(list[0]?.toolId).toBe('tool-a')
    expect(listIntents('no-such-message')).toEqual([])
  })

  it('setIntentStatus 更新状态并写入 error；未命中不写回', () => {
    const c = createConversation()
    const m = appendMessage(c.id, 'assistant', 'ok')!
    const intent = addIntent(m.id, 'tool-a', '改标题', [])
    setIntentStatus(intent.id, 'failed', '网络错误')
    expect(listIntents(m.id)[0].status).toBe('failed')
    expect(listIntents(m.id)[0].error).toBe('网络错误')
    // 未命中的 intentId 不改变现有意图状态
    setIntentStatus('nope', 'rejected')
    expect(listIntents(m.id)[0].status).toBe('failed')
  })
})
