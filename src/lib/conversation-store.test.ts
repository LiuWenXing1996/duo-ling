// conversation-store.ts 单测：会话库（IndexedDB duoling-chat）的读写契约。
//
// 本模块是会话的唯一写入口，语义里有几条**不在类型里**的规则，靠这里兜：
//   · 新会话序号在 meta store 里原子自增，不是「当前会话数 + 1」（删一个再建不重号）；
//   · 首条用户消息自动命名，且只在该会话尚无用户消息时触发；
//   · 重命名 trim 后为空即拒绝；会话不存在时 appendMessage 返回 null 且不广播；
//   · totalTokens / lastMessagePreview 由消息派生，不落库；
//   · 检索大小写不敏感，空查询退化为「最近若干条」。
//
// 写函数的广播埋在本文件（offscreen 与 chat 链路的落盘最终都汇到此处），
// 故整体 mock 掉 data-broadcast，只断言「哪些操作发通知、带不带 uuid」。
// 复位方式：deleteAllConversations() 清空两个 store 并把序号重置回 1 ——
// 模块级连接单例跨用例共享，这是同一 fake 连接下唯一的整体复位手段。
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, TokenUsage, UserMessage } from '@/shared/types'
import { broadcastDataChange } from './data-broadcast'
import {
  appendMessage,
  createConversation,
  deleteAllConversations,
  deleteConversation,
  listConversations,
  listMessages,
  renameConversation,
  searchConversations,
} from './conversation-store'

vi.mock('./data-broadcast', () => ({ broadcastDataChange: vi.fn() }))

const broadcast = vi.mocked(broadcastDataChange)

/** 固定基准时刻：消息时间全由它推算，避免用例依赖真实时钟 */
const T0 = Date.parse('2020-01-01T00:00:00.000Z')
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString()

let msgSeq = 0
function userMsg(conversationId: string, content: string, seconds = 0): UserMessage {
  msgSeq += 1
  return {
    id: `m${msgSeq}`,
    conversationId,
    role: 'user',
    content,
    parts: [{ type: 'text', text: content }],
    createdAt: at(seconds),
  }
}

function assistantMsg(
  conversationId: string,
  content: string,
  options: { seconds?: number; usage?: TokenUsage; parts?: AssistantMessage['parts'] } = {},
): AssistantMessage {
  msgSeq += 1
  return {
    id: `m${msgSeq}`,
    conversationId,
    role: 'assistant',
    content,
    parts: options.parts ?? [{ type: 'text', text: content }],
    createdAt: at(options.seconds ?? 0),
    ...(options.usage ? { usage: options.usage } : {}),
  }
}

beforeEach(async () => {
  await deleteAllConversations()
  broadcast.mockClear()
})

afterEach(async () => {
  await deleteAllConversations()
})

describe('会话序号（meta store 原子自增）', () => {
  it('连建两条：标题依次为「新会话 1」「新会话 2」', async () => {
    const a = await createConversation()
    const b = await createConversation()
    expect(a.title).toBe('新会话 1')
    expect(b.title).toBe('新会话 2')
  })

  it('删掉中间一条再建：序号不回退，不与剩余数量重合', async () => {
    await createConversation()
    const b = await createConversation()
    await createConversation()
    await deleteConversation(b.id)

    const next = await createConversation()

    // 库里只剩 3 条，但序号是 4 —— 若按「数量 + 1」算，这里会重号
    expect(next.title).toBe('新会话 4')
    expect(await listConversations()).toHaveLength(3)
  })

  it('清空全部会话后序号重置回 1', async () => {
    await createConversation()
    await createConversation()
    await deleteAllConversations()

    const fresh = await createConversation()

    expect(fresh.title).toBe('新会话 1')
  })
})

describe('appendMessage：首条用户消息自动命名', () => {
  it('首条用户消息：标题取正文（20 字以内原样）', async () => {
    const c = await createConversation()
    await appendMessage(userMsg(c.id, '帮我看下这个报错', 1))

    expect((await listConversations())[0].title).toBe('帮我看下这个报错')
  })

  it('超过 20 字：截断到 20 字并加省略号', async () => {
    const c = await createConversation()
    await appendMessage(userMsg(c.id, '一'.repeat(25), 1))

    expect((await listConversations())[0].title).toBe(`${'一'.repeat(20)}…`)
  })

  it('第二条用户消息不再改名（只有首条触发）', async () => {
    const c = await createConversation()
    await appendMessage(userMsg(c.id, '第一条', 1))
    await appendMessage(userMsg(c.id, '第二条不该成为标题', 2))

    expect((await listConversations())[0].title).toBe('第一条')
  })

  it('assistant 消息先落盘时，随后的首条用户消息仍能命名', async () => {
    const c = await createConversation()
    await appendMessage(assistantMsg(c.id, '先落盘的回复', { seconds: 1 }))
    await appendMessage(userMsg(c.id, '真正的首条提问', 2))

    expect((await listConversations())[0].title).toBe('真正的首条提问')
  })

  it('标题已非默认格式（用户手动改过名）时不动', async () => {
    const c = await createConversation()
    await renameConversation(c.id, '我的标题')
    await appendMessage(userMsg(c.id, '不该覆盖标题的正文', 1))

    expect((await listConversations())[0].title).toBe('我的标题')
  })

  it('首条用户消息正文为空白：保持默认标题', async () => {
    const c = await createConversation()
    await appendMessage(userMsg(c.id, '   ', 1))

    expect((await listConversations())[0].title).toBe('新会话 1')
  })

  it('刷新 lastMessageAt：会话按新消息时间重新参与排序', async () => {
    const c = await createConversation()
    await appendMessage(userMsg(c.id, 'x', 99))
    expect((await listConversations())[0].lastMessageAt).toBe(at(99))
  })
})

describe('入参守卫', () => {
  it('renameConversation：trim 后为空即拒绝，标题不变', async () => {
    const c = await createConversation()

    await expect(renameConversation(c.id, '   ')).resolves.toBeNull()
    expect((await listConversations())[0].title).toBe('新会话 1')
  })

  it('renameConversation：会话不存在返回 null', async () => {
    await expect(renameConversation('ghost', 'x')).resolves.toBeNull()
  })

  it('renameConversation：写回 trim 后的标题并广播', async () => {
    const c = await createConversation()
    broadcast.mockClear()

    const next = await renameConversation(c.id, '  新名字  ')

    expect(next?.title).toBe('新名字')
    expect(broadcast).toHaveBeenCalledWith('conversation', c.id)
  })

  it('renameConversation：被拒绝时没有任何广播', async () => {
    const c = await createConversation()
    broadcast.mockClear()

    await renameConversation(c.id, '')

    expect(broadcast).not.toHaveBeenCalled()
  })

  it('appendMessage：会话不存在返回 null，不落盘也不广播', async () => {
    await expect(appendMessage(userMsg('ghost', 'hello', 1))).resolves.toBeNull()
    await expect(listMessages('ghost')).resolves.toEqual([])
    expect(broadcast).not.toHaveBeenCalled()
  })
})

describe('列表派生字段', () => {
  it('totalTokens 只累加 assistant 的 usage', async () => {
    const c = await createConversation()
    await appendMessage(userMsg(c.id, '提问', 1))
    await appendMessage(assistantMsg(c.id, '回答一', { seconds: 2, usage: { totalTokens: 30 } }))
    await appendMessage(assistantMsg(c.id, '回答二', { seconds: 3, usage: { totalTokens: 12 } }))

    expect((await listConversations())[0].totalTokens).toBe(42)
  })

  it('assistant 没有 usage 时计 0', async () => {
    const c = await createConversation()
    await appendMessage(assistantMsg(c.id, '没有用量', { seconds: 1 }))

    expect((await listConversations())[0].totalTokens).toBe(0)
  })

  it('lastMessagePreview 取最后一条消息的正文', async () => {
    const c = await createConversation()
    await appendMessage(userMsg(c.id, '前面这条', 1))
    await appendMessage(assistantMsg(c.id, '最后这条', { seconds: 2 }))

    expect((await listConversations())[0].lastMessagePreview).toBe('最后这条')
  })

  it('没有任何消息的会话：preview 为空串', async () => {
    await createConversation()

    expect((await listConversations())[0].lastMessagePreview).toBe('')
  })

  it('正文为空但带图片：preview 给 [图片] 占位', async () => {
    const c = await createConversation()
    await appendMessage(
      assistantMsg(c.id, '', {
        seconds: 1,
        parts: [
          { type: 'file', mediaType: 'image/png', filename: 'a.png', url: 'data:image/png;base64,AA' },
        ],
      }),
    )

    expect((await listConversations())[0].lastMessagePreview).toBe('[图片]')
  })

  it('正文为空且无附件：preview 为空串', async () => {
    const c = await createConversation()
    await appendMessage(assistantMsg(c.id, '', { seconds: 1 }))

    expect((await listConversations())[0].lastMessagePreview).toBe('')
  })

  it('列表按 lastMessageAt 倒序（新在前）', async () => {
    const a = await createConversation()
    const b = await createConversation()
    await appendMessage(userMsg(a.id, '旧的', 10))
    await appendMessage(userMsg(b.id, '新的', 20))

    expect((await listConversations()).map((c) => c.id)).toEqual([b.id, a.id])
  })
})

describe('listMessages', () => {
  it('只取本会话的消息，按 createdAt 升序', async () => {
    const c = await createConversation()
    const other = await createConversation()
    await appendMessage(userMsg(c.id, '第三条', 30))
    await appendMessage(userMsg(c.id, '第一条', 10))
    await appendMessage(userMsg(c.id, '第二条', 20))
    await appendMessage(userMsg(other.id, '别人的', 40))

    const list = await listMessages(c.id)

    expect(list.map((m) => m.content)).toEqual(['第一条', '第二条', '第三条'])
  })
})

describe('searchConversations', () => {
  it('空查询：返回最近 limit 条，snippet 为空串', async () => {
    const a = await createConversation()
    const b = await createConversation()
    const c = await createConversation()
    await appendMessage(userMsg(a.id, 'A', 10))
    await appendMessage(userMsg(b.id, 'B', 20))
    await appendMessage(userMsg(c.id, 'C', 30))

    const hits = await searchConversations('   ', 2)

    expect(hits.map((h) => h.conversation.id)).toEqual([c.id, b.id])
    expect(hits.every((h) => h.snippet === '')).toBe(true)
  })

  it('标题命中：snippet 为空（摘要在正文命中时才给）', async () => {
    const c = await createConversation()
    await appendMessage(userMsg(c.id, 'Alpha 主题', 1))

    const hits = await searchConversations('alpha')

    expect(hits.map((h) => h.conversation.id)).toEqual([c.id])
    expect(hits[0].snippet).toBe('')
  })

  it('正文命中：带出命中片段，大小写不敏感', async () => {
    const c = await createConversation()
    await renameConversation(c.id, '中性标题')
    await appendMessage(userMsg(c.id, '正文里藏着 NEEDLE 这个词', 1))

    const hits = await searchConversations('needle')

    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).toContain('NEEDLE')
  })

  it('命中片段过长时截断并加省略号', async () => {
    const c = await createConversation()
    await renameConversation(c.id, '中性标题')
    await appendMessage(userMsg(c.id, `${'x'.repeat(120)} needle`, 1))

    const [hit] = await searchConversations('needle')

    expect(hit.snippet).toHaveLength(101)
    expect(hit.snippet.endsWith('…')).toBe(true)
  })

  it('搜不到：返回空数组', async () => {
    await createConversation()

    await expect(searchConversations('zzz')).resolves.toEqual([])
  })
})

describe('删除', () => {
  it('deleteConversation：连带删掉该会话的全部消息，不误伤别的会话', async () => {
    const c = await createConversation()
    const other = await createConversation()
    await appendMessage(userMsg(c.id, 'A', 1))
    await appendMessage(assistantMsg(c.id, 'B', { seconds: 2 }))
    await appendMessage(userMsg(other.id, '别的会话', 3))

    await deleteConversation(c.id)

    await expect(listMessages(c.id)).resolves.toEqual([])
    expect((await listConversations()).map((x) => x.id)).toEqual([other.id])
    expect(await listMessages(other.id)).toHaveLength(1)
  })

  it('deleteAllConversations：会话与消息一并清空', async () => {
    const c = await createConversation()
    await appendMessage(userMsg(c.id, 'A', 1))

    await deleteAllConversations()

    await expect(listConversations()).resolves.toEqual([])
    await expect(listMessages(c.id)).resolves.toEqual([])
  })
})

describe('变更广播（写函数的唯一出口）', () => {
  it('createConversation：广播 domain + 新会话 id', async () => {
    const c = await createConversation()

    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith('conversation', c.id)
  })

  it('appendMessage：会话存在时广播该 id', async () => {
    const c = await createConversation()
    broadcast.mockClear()

    await appendMessage(userMsg(c.id, 'hello', 1))

    expect(broadcast).toHaveBeenCalledWith('conversation', c.id)
  })

  it('deleteConversation：广播被删的会话 id', async () => {
    const c = await createConversation()
    broadcast.mockClear()

    await deleteConversation(c.id)

    expect(broadcast).toHaveBeenCalledWith('conversation', c.id)
  })

  it('deleteAllConversations：不带 uuid（表示全量变化）', async () => {
    await createConversation()
    broadcast.mockClear()

    await deleteAllConversations()

    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith('conversation')
  })
})
