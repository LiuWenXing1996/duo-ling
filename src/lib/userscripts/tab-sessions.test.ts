// tab-sessions / runtime 库 tab_sessions 表单测：取号、盖章、启动划断、环形裁剪。
// 全走 fake-indexeddb，用例间 clearAllForTests 清库保证隔离。
//
// 刻意不断言「具体时刻是多少」—— 时刻一律「记得到就记」，测的是「有没有记、记到什么程度」：
// 记得到就必须有值，记不到就必须缺省（不许拿别的时刻顶上）。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearAllForTests, listTabSessions, seedTabSessionsForTests } from './runtime-db'
import { noteTabClosed, noteTabCreated, noteTabUrl, splitTabSessionsAtBrowserStart, tabSessionIdFor } from './tab-sessions'
import { TAB_SESSION_MAX } from './types'

beforeEach(async () => {
  await clearAllForTests()
})

/** 按 tabId 取那一行（表里同一 tabId 至多一行未结束的） */
async function rowOf(tabId: number) {
  return (await listTabSessions()).find((r) => r.tabId === tabId)
}

describe('标签页存续登记', () => {
  it('取号：先建的标签页第一个号，同一个 tabId 再问拿到同一个号（不重复建行）', async () => {
    const id = await tabSessionIdFor(7, 'https://a.example/x')
    expect(id).toBeTruthy()
    expect(await tabSessionIdFor(7)).toBe(id)

    const rows = await listTabSessions()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tabId: 7, url: 'https://a.example/x' })
    // 没看着它出生：出生时刻必须缺省（拿「发现它的时刻」顶上就是让字段名撒谎）
    expect(rows[0].createdAt).toBeUndefined()
  })

  it('onCreated 建行：记下出生时刻；同一 tabId 已有开着的行时不重复建号', async () => {
    await noteTabCreated(3, 'https://a.example/')
    const first = await rowOf(3)
    expect(first?.createdAt).toBeTypeOf('number')

    await noteTabCreated(3, 'https://a.example/other')
    const rows = await listTabSessions()
    expect(rows).toHaveLength(1)
    expect(rows[0].tabSessionId).toBe(first?.tabSessionId)
    // 出生时刻不被后来的事件改写
    expect(rows[0].createdAt).toBe(first?.createdAt)
  })

  it('新标签页还没有地址时也能建行（地址留空），之后导航再补上', async () => {
    await noteTabCreated(4)
    expect((await rowOf(4))?.url).toBeUndefined()

    await noteTabUrl(4, 'https://b.example/p')
    expect((await rowOf(4))?.url).toBe('https://b.example/p')
  })

  it('onRemoved 盖关闭时刻；没登记过的标签页不补幽灵行', async () => {
    await tabSessionIdFor(5)
    await noteTabClosed(5)
    const closed = await rowOf(5)
    expect(closed?.ended).toBe(true)
    expect(closed?.closedAt).toBeTypeOf('number')

    await noteTabClosed(99)
    expect(await listTabSessions()).toHaveLength(1)
  })

  it('启动划断：把还开着的行盖章结束、时刻留空；已结束的行不被改写', async () => {
    await tabSessionIdFor(1)
    await tabSessionIdFor(2)
    await noteTabClosed(1)

    expect(await splitTabSessionsAtBrowserStart()).toBe(1) // 只动了那一条还开着的

    const rows = await listTabSessions()
    const open = rows.find((r) => r.tabId === 2)
    expect(open?.ended).toBe(true)
    expect(open?.closedAt).toBeUndefined() // 它何时关的没人知道 —— 不编
    // 正常关闭的那条保留真实时刻
    expect(rows.find((r) => r.tabId === 1)?.closedAt).toBeTypeOf('number')
  })

  it('划断后再取号是新的一行（上个浏览器会话的残留行不会再被认领）', async () => {
    const before = await tabSessionIdFor(1)
    await splitTabSessionsAtBrowserStart()
    const after = await tabSessionIdFor(1)
    expect(after).not.toBe(before)
    expect((await listTabSessions()).filter((r) => r.tabId === 1)).toHaveLength(2)
  })
})

describe('标签页存续表的环形裁剪', () => {
  it('只裁已结束的行：还开着的一行都不删（活账优先于上限）', async () => {
    // 备料一次灌满：裁剪只在表满时才触发，而逐条取号建满上限纯属耗时 ——
    // 取号那条路自有上一组用例覆盖，这里只测「表满之后裁掉哪几条」。
    // 最早的 5 行已结束（它们是仅有的可裁候选），其余都还开着。
    await seedTabSessionsForTests(
      Array.from({ length: TAB_SESSION_MAX }, (_, i) => ({
        tabId: i + 1,
        ...(i < 5 ? { ended: true } : {}),
      })),
    )
    // 再登记三个新的：必然触发裁剪，只该裁已结束的那几条
    await tabSessionIdFor(9001)
    await tabSessionIdFor(9002)
    await tabSessionIdFor(9003)

    const rows = await listTabSessions()
    expect(rows).toHaveLength(TAB_SESSION_MAX)
    expect(rows.filter((r) => r.ended !== true)).toHaveLength(TAB_SESSION_MAX - 2)
    expect(rows.filter((r) => r.ended === true)).toHaveLength(2)
  })

  it('对外只给记录本身，不把内部的裁剪排序键带出去', async () => {
    await tabSessionIdFor(1)
    const [row] = await listTabSessions()
    expect(Object.keys(row).sort()).toEqual(['tabId', 'tabSessionId'])
  })
})
