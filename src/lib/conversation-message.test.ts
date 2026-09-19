// 单测：落盘 ⇄ 渲染的唯一转换点（toPersistedMessage / toUiMessage）。
//
// 锁的语义（2026-09-19 事故，见 lib/conversation-message.ts 头注释）：
//   · 落盘必须同时写下 parts（真相源）与 content（派生值）——user 路径曾只写 content，
//     结果"发送时看得到、重开会话后用户气泡全空"；
//   · 落盘是深拷贝，落盘对象与传入的 UIMessage 不共享引用（Vue 代理结构化克隆会炸）；
//   · 角色专有字段只落在对应分支（user → pageContext；assistant → reasoning / usage）；
//   · 回显只认 parts，且缺 parts 时不炸（库里可能躺着旧记录）。
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import type { Message } from '@/shared/types'
import { toPersistedMessage, toUiMessage } from './conversation-message'

const ui = (overrides?: Partial<UIMessage>): UIMessage => ({
  id: 'u1',
  role: 'user',
  parts: [{ type: 'text', text: '把这个字体变大' }],
  ...overrides,
})

const elementCtx = {
  pickedAt: 1,
  pageUrl: 'https://example.com',
  summary: {
    tag: 'h1',
    classes: [],
    attrs: {},
    selectors: [{ selector: 'h1', hitCount: 1 }],
    textSample: 'Example Domain',
    htmlSample: '<h1>Example Domain</h1>',
  },
  full: { attrs: {}, outerHTML: '<h1>Example Domain</h1>', parentChain: [] },
}

describe('toPersistedMessage', () => {
  it('user：parts 与 content 同时落盘（content 为 text parts 拼接）', () => {
    const m = toPersistedMessage(ui(), { conversationId: 'c1' })
    expect(m.role).toBe('user')
    expect(m.parts).toEqual([{ type: 'text', text: '把这个字体变大' }])
    expect(m.content).toBe('把这个字体变大')
  })

  it('user：多段 text part 按顺序拼接', () => {
    const m = toPersistedMessage(
      ui({ parts: [{ type: 'text', text: '前段' }, { type: 'text', text: '后段' }] }),
      { conversationId: 'c1' },
    )
    expect(m.content).toBe('前段后段')
  })

  it('落盘是深拷贝：与传入的 UIMessage 不共享引用', () => {
    const parts = [{ type: 'text' as const, text: '原文' }]
    const m = toPersistedMessage(ui({ parts }), { conversationId: 'c1' })
    expect(m.parts).not.toBe(parts)
    parts[0].text = '改过了'
    expect(m.parts[0]).toEqual({ type: 'text', text: '原文' })
  })

  it('user：pageContext 落盘；id / createdAt 可注入（缺省取 ui.id 与当前时刻）', () => {
    const m = toPersistedMessage(ui(), {
      conversationId: 'c1',
      pageContext: { element: elementCtx },
      createdAt: '2026-09-19T04:08:44.000Z',
    })
    expect(m.role === 'user' && m.pageContext).toEqual({ element: elementCtx })
    expect(m.id).toBe('u1')
    expect(m.createdAt).toBe('2026-09-19T04:08:44.000Z')

    const other = toPersistedMessage(ui({ id: 'u2' }), { conversationId: 'c1', id: 'task-1' })
    expect(other.id).toBe('task-1')
    expect(Number.isNaN(Date.parse(other.createdAt))).toBe(false)
  })

  it('assistant：正文空时给可见兜底，reasoning / usage 有值才写', () => {
    const empty = toPersistedMessage(
      ui({ role: 'assistant', parts: [{ type: 'text', text: '   ' }] }),
      { conversationId: 'c1' },
    )
    expect(empty.role).toBe('assistant')
    expect(empty.content).toBe('（模型未生成回复内容）')
    expect('reasoning' in empty).toBe(false)
    expect('usage' in empty).toBe(false)

    const full = toPersistedMessage(
      ui({
        role: 'assistant',
        parts: [{ type: 'reasoning', text: '想想' }, { type: 'text', text: '答案' }],
      }),
      { conversationId: 'c1', usage: { totalTokens: 42 } },
    )
    expect(full.content).toBe('答案')
    expect(full.role === 'assistant' && full.reasoning).toBe('想想')
    expect(full.role === 'assistant' && full.usage).toEqual({ totalTokens: 42 })
  })

  it('角色专有字段不串门：assistant 落盘不带 pageContext', () => {
    const m = toPersistedMessage(
      ui({ role: 'assistant', parts: [{ type: 'text', text: '好的' }] }),
      { conversationId: 'c1', pageContext: { element: elementCtx } },
    )
    expect('pageContext' in m).toBe(false)
  })
})

describe('toUiMessage', () => {
  it('parts 原样回显（用户气泡正文的真相源）', () => {
    const stored = toPersistedMessage(ui(), { conversationId: 'c1' })
    expect(toUiMessage(stored).parts).toEqual([{ type: 'text', text: '把这个字体变大' }])
  })

  it('user 的 pageContext 挂回 metadata；未附上下文时整体不带 metadata', () => {
    const withCtx = toUiMessage(
      toPersistedMessage(ui(), { conversationId: 'c1', pageContext: { element: elementCtx } }),
    )
    expect(withCtx.metadata).toEqual({ pageContext: { element: elementCtx } })

    const plain = toUiMessage(toPersistedMessage(ui(), { conversationId: 'c1' }))
    expect('metadata' in plain).toBe(false)
  })

  it('旧记录缺 parts 时不炸（按空渲染）', () => {
    const legacy = {
      id: 'm-old',
      conversationId: 'c1',
      role: 'user',
      content: '老消息',
      createdAt: '2026-01-01T00:00:00.000Z',
    } as unknown as Message
    expect(toUiMessage(legacy).parts).toEqual([])
  })
})
