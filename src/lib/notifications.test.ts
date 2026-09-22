// notifications 单测：通知中心的读写往返，与两条封顶规则。
//
// 这里守的是「角标数字的来源」：未读数必须与列表一致；同一会话跑两次不能虚增两条（那是同一件事
// 的最新状态）；已读不能无限堆积（它不是历史记录，只是「刚看过的」）。脏数据（手改过库 / 旧格式）
// 也必须能容错 —— 否则 popup 一打开就整块炸掉。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as appDb from '@/lib/app-db'
import {
  addChatDone,
  countUnread,
  listNotifications,
  markAllRead,
  markConversationRead,
  markRead,
  removeAll,
  removeByConversation,
} from './notifications'

/** 可控时钟：列表按 createdAt 排序，同一毫秒内连写会让顺序不稳 */
let now = 0

beforeEach(async () => {
  await appDb.clearAllForTests()
  now = 1_000
  vi.restoreAllMocks()
  // 读的是闭包里的 now，测试中途改 now 即推进时钟
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})

describe('记一条与读回', () => {
  it('记下即有未读，新的在前', async () => {
    await addChatDone({ conversationId: 'c1', tabId: 7, host: 'a.com' })
    now = 2_000
    await addChatDone({ conversationId: 'c2', tabId: 8, host: 'b.com' })

    const list = await listNotifications()
    expect(list.map((n) => n.conversationId)).toEqual(['c2', 'c1'])
    expect(list[0]?.host).toBe('b.com')
    expect(await countUnread()).toBe(2)
  })

  it('同一会话再跑一次只留一条（角标不虚增）', async () => {
    await addChatDone({ conversationId: 'c1', tabId: 7, host: 'a.com' })
    now = 2_000
    await addChatDone({ conversationId: 'c1', tabId: 7, host: 'a.com' })

    const list = await listNotifications()
    expect(list).toHaveLength(1)
    expect(list[0]?.createdAt).toBe(2_000)
    expect(await countUnread()).toBe(1)
  })

  it('已读之后同一会话再记一条：新的算未读，老的那条留着', async () => {
    const first = await addChatDone({ conversationId: 'c1', tabId: 7, host: 'a.com' })
    await markRead(first.id)
    now = 2_000
    await addChatDone({ conversationId: 'c1', tabId: 7, host: 'a.com' })

    expect(await countUnread()).toBe(1)
    expect(await listNotifications()).toHaveLength(2)
  })
})

describe('标已读', () => {
  it('按会话标：别的会话的未读不受影响', async () => {
    await addChatDone({ conversationId: 'c1', tabId: 7, host: 'a.com' })
    await addChatDone({ conversationId: 'c2', tabId: 8, host: 'b.com' })

    expect(await markConversationRead('c1')).toBe(1)
    const list = await listNotifications()
    expect(list.find((n) => n.conversationId === 'c1')?.readAt).toBeTypeOf('number')
    expect(list.find((n) => n.conversationId === 'c2')?.readAt).toBeUndefined()
    expect(await countUnread()).toBe(1)
  })

  it('全部已读：未读归零，已读条目仍在', async () => {
    await addChatDone({ conversationId: 'c1', tabId: 7, host: 'a.com' })
    now = 2_000
    await addChatDone({ conversationId: 'c2', tabId: 8, host: 'b.com' })

    expect(await markAllRead()).toBe(2)
    expect(await countUnread()).toBe(0)
    expect(await listNotifications()).toHaveLength(2)
    // 再标一次没有可标的（幂等）
    expect(await markAllRead()).toBe(0)
  })

  it('标一条不存在的 id 是无操作', async () => {
    await addChatDone({ conversationId: 'c1', tabId: 7, host: 'a.com' })
    await markRead('not-there')
    expect(await countUnread()).toBe(1)
  })
})

describe('封顶', () => {
  it('已读最多留 20 条，丢最老的；未读不受已读封顶影响', async () => {
    for (let i = 0; i < 25; i++) {
      now = 1_000 + i
      const n = await addChatDone({ conversationId: `c${i}`, tabId: null, host: '' })
      await markRead(n.id)
    }
    now = 9_000
    await addChatDone({ conversationId: 'unread-one', tabId: null, host: '' })

    const list = await listNotifications()
    expect(list.filter((n) => n.readAt != null)).toHaveLength(20)
    expect(list.some((n) => n.conversationId === 'c0'), '最老的已读该被丢掉').toBe(false)
    expect(list.some((n) => n.conversationId === 'c24'), '最新的已读要留住').toBe(true)
    expect(await countUnread()).toBe(1)
  })
})

describe('会话被删时清通知', () => {
  it('按会话清：只动那一条，别的留着', async () => {
    await addChatDone({ conversationId: 'c1', tabId: 7, host: 'a.com' })
    await addChatDone({ conversationId: 'c2', tabId: 8, host: 'b.com' })

    expect(await removeByConversation('c1')).toBe(1)
    expect((await listNotifications()).map((n) => n.conversationId)).toEqual(['c2'])
    expect(await countUnread()).toBe(1)
  })

  it('全清：已读的也一并清掉（它们指向的会话同样没了）', async () => {
    const first = await addChatDone({ conversationId: 'c1', tabId: 7, host: 'a.com' })
    await markRead(first.id)
    await addChatDone({ conversationId: 'c2', tabId: 8, host: 'b.com' })

    expect(await removeAll()).toBe(2)
    expect(await listNotifications()).toHaveLength(0)
    expect(await countUnread()).toBe(0)
  })
})

describe('容错', () => {
  it('库里的脏数据被丢掉，不炸整块列表', async () => {
    await appDb.set('notifications', [
      null,
      42,
      { id: 'no-kind' },
      { id: 'no-conv', kind: 'chat-done', createdAt: 1 },
      { id: 'ok', kind: 'chat-done', conversationId: 'c1', createdAt: 5 },
    ])
    const list = await listNotifications()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe('ok')
    expect(list[0]?.host, '缺字段补默认').toBe('')
    expect(list[0]?.tabId).toBeNull()
  })
})
