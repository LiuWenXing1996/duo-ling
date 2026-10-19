// tab-sessions / runtime 库 tab_sessions 与 tab_events 两表的单测：记录开关（含它在时间线上
// 留下的启停标记）、被动取号、盖章、启动划断、环形裁剪，以及刷新 / 地址变更两类事件的判定。
// 全走 fake-indexeddb；用例间清库 **加** 清内存导航印记（后者不落库，清库清不掉）——双重隔离。
//
// 刻意不断言「具体时刻是多少」—— 时刻一律「记得到就记」，测的是「有没有记、记到什么程度」：
// 记得到就必须有值，记不到就必须缺省（不许拿别的时刻顶上）。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearRuntimeDbForTests,
  listTabEvents,
  listTabSessions,
  seedTabSessionsForTests,
} from './runtime-db'
import {
  noteTabClosed,
  noteTabReloaded,
  noteTabUrlChanged,
  recordingTabSessionId,
  resetTabNavPendingForTests,
  setTabRecording,
  splitTabSessionsAtBrowserStart,
} from './tab-sessions'
import { TAB_SESSION_MAX } from '@duoling/shared'

beforeEach(async () => {
  // 导航印记是内存态：不清它，上一个用例在同一 tabId 上留的印会把本用例的刷新判成「导航的后续」
  resetTabNavPendingForTests()
  await clearRuntimeDbForTests()
})

/** 按 tabId 取那一行（表里同一 tabId 至多一行未结束的） */
async function rowOf(tabId: number) {
  return (await listTabSessions()).find((r) => r.tabId === tabId)
}

/**
 * 只看文档级事件（刷新 / 地址变更）。
 * 用它的理由：开记录本身就会落一条「开始记录」，而判定组的用例判的是一次加载该落几条
 * 文档事件 —— 数里掺着开关事件只会让断言变脆。开关事件由下面单独一组覆盖。
 */
async function docEvents() {
  return (await listTabEvents()).filter((e) => e.kind === 'reload' || e.kind === 'url')
}

describe('标签页存续登记', () => {
  it('取号是被动的：没开记录就没有号，也不建行', async () => {
    expect(await recordingTabSessionId(7)).toBeUndefined()
    expect(await listTabSessions()).toHaveLength(0)
  })

  it('打开记录：建一行并记下开关；此后取号才拿得到号', async () => {
    await setTabRecording(7, true, 'https://a.example/x')
    const row = await rowOf(7)
    expect(row).toMatchObject({ tabId: 7, url: 'https://a.example/x', recording: true })
    // 建行的时机不是它出生的时刻：出生时刻必须缺省（拿别的时刻顶上就是让字段名撒谎）
    expect(row?.createdAt).toBeUndefined()

    expect(await recordingTabSessionId(7)).toBe(row?.tabSessionId)
    expect(await listTabSessions()).toHaveLength(1)
  })

  it('重复打开不重复建行（同一 tabId 只有一个号）', async () => {
    await setTabRecording(3, true, 'https://a.example/')
    const first = await rowOf(3)
    await setTabRecording(3, true, 'https://a.example/other')

    const rows = await listTabSessions()
    expect(rows).toHaveLength(1)
    expect(rows[0].tabSessionId).toBe(first?.tabSessionId)
    // 地址的刷新归 onUpdated（见下一例），开关这一下不动它
    expect(rows[0].url).toBe('https://a.example/')
  })

  it('关掉记录：取号立刻没号，但行留着（历史不因一次关开关消失）', async () => {
    await setTabRecording(8, true, 'https://a.example/')
    const id = (await rowOf(8))?.tabSessionId

    await setTabRecording(8, false)
    expect(await recordingTabSessionId(8)).toBeUndefined()

    const rows = await listTabSessions()
    expect(rows).toHaveLength(1)
    expect(rows[0].tabSessionId).toBe(id)
    // 关掉是删字段而非写 false：读侧只有「缺省即没开」一条判据
    expect(rows[0].recording).toBeUndefined()
  })

  it('这一页还没有地址时也能开记录（地址留空），之后导航再补上', async () => {
    await setTabRecording(4, true)
    expect((await rowOf(4))?.url).toBeUndefined()

    await noteTabUrlChanged(4, 'https://b.example/p')
    expect((await rowOf(4))?.url).toBe('https://b.example/p')
  })

  it('onRemoved 盖关闭时刻；没登记过的标签页不补幽灵行', async () => {
    await setTabRecording(5, true)
    await noteTabClosed(5)
    const closed = await rowOf(5)
    expect(closed?.ended).toBe(true)
    expect(closed?.closedAt).toBeTypeOf('number')

    await noteTabClosed(99)
    expect(await listTabSessions()).toHaveLength(1)
  })

  it('启动划断：把还开着的行盖章结束、时刻留空；已结束的行不被改写', async () => {
    await setTabRecording(1, true)
    await setTabRecording(2, true)
    await noteTabClosed(1)

    expect(await splitTabSessionsAtBrowserStart()).toBe(1) // 只动了那一条还开着的

    const rows = await listTabSessions()
    const open = rows.find((r) => r.tabId === 2)
    expect(open?.ended).toBe(true)
    expect(open?.closedAt).toBeUndefined() // 它何时关的没人知道 —— 不编
    // 正常关闭的那条保留真实时刻
    expect(rows.find((r) => r.tabId === 1)?.closedAt).toBeTypeOf('number')
  })

  it('划断后再开记录是新的一行（上个浏览器会话的残留行不会被认领）', async () => {
    await setTabRecording(1, true)
    await splitTabSessionsAtBrowserStart()
    await setTabRecording(1, true)

    const rows = (await listTabSessions()).filter((r) => r.tabId === 1)
    expect(rows).toHaveLength(2)
    // 只有新那一行在记，旧行已结束
    expect(rows.filter((r) => r.ended !== true && r.recording === true)).toHaveLength(1)
  })
})

describe('标签页存续表的环形裁剪', () => {
  it('只裁已结束的行：还开着的一行都不删（活账优先于上限）', async () => {
    // 备料一次灌满：裁剪只在表满时才触发，而逐条建满上限纯属耗时 ——
    // 建行那条路自有上一组用例覆盖，这里只测「表满之后裁掉哪几条」。
    // 最早的 5 行已结束（它们是仅有的可裁候选），其余都还开着。
    await seedTabSessionsForTests(
      Array.from({ length: TAB_SESSION_MAX }, (_, i) => ({
        tabId: i + 1,
        ...(i < 5 ? { ended: true } : {}),
      })),
    )
    // 再开三个记录：必然触发裁剪，只该裁已结束的那几条
    await setTabRecording(9001, true)
    await setTabRecording(9002, true)
    await setTabRecording(9003, true)

    const rows = await listTabSessions()
    expect(rows).toHaveLength(TAB_SESSION_MAX)
    expect(rows.filter((r) => r.ended !== true)).toHaveLength(TAB_SESSION_MAX - 2)
    expect(rows.filter((r) => r.ended === true)).toHaveLength(2)
  })

  it('对外只给记录本身，不把内部的裁剪排序键带出去', async () => {
    await setTabRecording(1, true)
    const [row] = await listTabSessions()
    expect(Object.keys(row).sort()).toEqual(['recording', 'tabId', 'tabSessionId'])
  })
})

describe('刷新与地址变更的判定', () => {
  /** 开一页记录并从 A 出发（事件类用例都从这个状态起；顺带落一条「开始记录」，故断言走 docEvents） */
  async function opened(tabId = 4): Promise<string> {
    await setTabRecording(tabId, true, 'https://a.example/')
    const id = (await rowOf(tabId))?.tabSessionId
    if (!id) throw new Error('没建出行来')
    return id
  }

  it('同地址重载：记一条「页面刷新」，地址不动', async () => {
    const id = await opened()
    await noteTabReloaded(4, 'https://a.example/')

    expect(await docEvents()).toEqual([
      expect.objectContaining({ tabSessionId: id, kind: 'reload', url: 'https://a.example/' }),
    ])
    expect((await rowOf(4))?.url).toBe('https://a.example/')
  })

  it('导航（url 回调先到）：只记一条「地址变更」，随后的 loading 不再记刷新', async () => {
    const id = await opened()
    await noteTabUrlChanged(4, 'https://b.example/p')
    await noteTabReloaded(4, 'https://b.example/p')

    const events = await docEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ tabSessionId: id, kind: 'url', url: 'https://b.example/p' })
    // 事件与行内地址同事务更新：不许出现「行内还停在 A，时间线却说地址变了」
    expect((await rowOf(4))?.url).toBe('https://b.example/p')
  })

  it('导航（status 回调先到）：同样只记一条，且记的是「地址变更」而不是刷新', async () => {
    await opened()
    await noteTabReloaded(4, 'https://b.example/p')
    await noteTabUrlChanged(4, 'https://b.example/p')

    const events = await docEvents()
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('url')
  })

  it('SPA 软导航（只来 url 回调）：记一条「地址变更」', async () => {
    await opened()
    await noteTabUrlChanged(4, 'https://a.example/next')

    const events = await docEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'url', url: 'https://a.example/next' })
  })

  it('同一个地址被重复报来：只记第一条（同一次变化不该记两条）', async () => {
    await opened()
    await noteTabUrlChanged(4, 'https://b.example/p')
    await noteTabUrlChanged(4, 'https://b.example/p')

    expect(await docEvents()).toHaveLength(1)
  })

  it('取不到地址的页：重载照样记一条「刷新」（地址无从比较，不因此不记）', async () => {
    await setTabRecording(6, true)
    await noteTabReloaded(6)

    expect(await docEvents()).toEqual([
      expect.objectContaining({ tabSessionId: (await rowOf(6))?.tabSessionId, kind: 'reload' }),
    ])
  })

  it('没开记录的页：两条支都不记（被动记录的红线）', async () => {
    expect(await noteTabReloaded(99, 'https://x.example/')).toBe(false)
    expect(await noteTabUrlChanged(99, 'https://x.example/')).toBe(false)
    expect(await listTabSessions()).toHaveLength(0)
    expect(await listTabEvents()).toHaveLength(0)
  })

  it('已结束的行不受理事件（tabId 被复用也串不到旧行）', async () => {
    await opened(5)
    await noteTabClosed(5)

    expect(await noteTabReloaded(5, 'https://a.example/')).toBe(false)
    expect(await docEvents()).toHaveLength(0)
  })

  it('SPA 之后紧接着的那次刷新会被「刚改过地址」的印吞掉（已知取舍）', async () => {
    await opened()
    await noteTabUrlChanged(4, 'https://a.example/next')
    await noteTabReloaded(4, 'https://a.example/next')

    // 只剩 SPA 那一条：印还没过期，这次加载被当成它的后续。
    // 反过来不留印的话，每次「导航 = url 回调 + loading」都会落成两条 —— 那才是高频的错。
    expect(await docEvents()).toHaveLength(1)
  })

  it('事件全量按时刻升序给（时间线混排的前提）', async () => {
    await opened()
    await noteTabReloaded(4, 'https://a.example/')
    await noteTabUrlChanged(4, 'https://b.example/p')

    const events = await docEvents()
    expect(events.map((e) => e.kind)).toEqual(['reload', 'url'])
    // 文档级事件一律带时刻（时刻缺省的只有启动划断那种收尾）：先钉住这个前提，再比大小
    const [first, second] = events
    const t0 = first.time
    const t1 = second.time
    if (t0 === undefined || t1 === undefined) throw new Error('文档级事件应当带时刻')
    expect(t0).toBeLessThanOrEqual(t1)
  })
})

describe('记录开关的启停标记', () => {
  it('打开记录：建行那一刻就落一条「开始记录」，带时刻', async () => {
    await setTabRecording(7, true, 'https://a.example/')

    const events = await listTabEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      tabSessionId: (await rowOf(7))?.tabSessionId,
      kind: 'recordOn',
    })
    // 时刻必须记到：这是用户的手势，SW 就在现场
    expect(events[0].time).toBeTypeOf('number')
  })

  it('已经开着再打开：不重复记（开关没动就没有新的一段）', async () => {
    await setTabRecording(7, true, 'https://a.example/')
    await setTabRecording(7, true, 'https://a.example/')

    expect(await listTabEvents()).toHaveLength(1)
  })

  it('关掉记录：落一条「结束记录」，带时刻；行留着', async () => {
    await setTabRecording(8, true, 'https://a.example/')
    await setTabRecording(8, false)

    const events = await listTabEvents()
    expect(events.map((e) => e.kind)).toEqual(['recordOn', 'recordOff'])
    expect(events[1].time).toBeTypeOf('number')
    expect(await listTabSessions()).toHaveLength(1)
  })

  it('关掉再打开：同一行上分两段记（开始 / 结束 / 开始）', async () => {
    await setTabRecording(9, true, 'https://a.example/')
    await setTabRecording(9, false)
    await setTabRecording(9, true, 'https://a.example/')

    const events = await listTabEvents()
    expect(events.map((e) => e.kind)).toEqual(['recordOn', 'recordOff', 'recordOn'])
    // 开关反复开合不新建行：一段是事件多几条，不是多一行
    expect(await listTabSessions()).toHaveLength(1)
  })

  it('没开过记录的页：关它也什么都不记（红线）', async () => {
    await setTabRecording(99, false)

    expect(await listTabEvents()).toHaveLength(0)
  })

  it('标签页关闭时还在记：补一条「结束记录」，时刻就是关闭时刻', async () => {
    await setTabRecording(5, true, 'https://a.example/')
    await noteTabClosed(5)

    const events = await listTabEvents()
    expect(events.map((e) => e.kind)).toEqual(['recordOn', 'recordOff'])
    expect(events[1].time).toBe((await rowOf(5))?.closedAt)
  })

  it('标签页关闭时已经关掉过开关：不补（那一段早收过尾了）', async () => {
    await setTabRecording(5, true, 'https://a.example/')
    await setTabRecording(5, false)
    await noteTabClosed(5)

    expect((await listTabEvents()).map((e) => e.kind)).toEqual(['recordOn', 'recordOff'])
  })

  it('浏览器启动划断：当时还在记的行补一条「结束记录」，且**不带时刻**', async () => {
    await setTabRecording(1, true, 'https://a.example/')
    await splitTabSessionsAtBrowserStart()

    const events = await listTabEvents()
    expect(events.map((e) => e.kind)).toEqual(['recordOn', 'recordOff'])
    // 不知道上一次会话几点结束的：宁可缺，不拿「现在」顶上（与 closedAt 留空同一口径）
    expect(events[1].time).toBeUndefined()
  })

  it('浏览器启动划断：已经关掉过开关的行不补', async () => {
    await setTabRecording(1, true, 'https://a.example/')
    await setTabRecording(1, false)
    await splitTabSessionsAtBrowserStart()

    expect((await listTabEvents()).map((e) => e.kind)).toEqual(['recordOn', 'recordOff'])
  })

  it('缺时刻的事件排在末尾（升序）：它按定义发生在该行所有已知事件之后', async () => {
    await setTabRecording(1, true, 'https://a.example/')
    await splitTabSessionsAtBrowserStart() // 划断：这一行的 recordOff 没有时刻
    await setTabRecording(1, true, 'https://a.example/') // 划断后是同 tabId 的新一行

    const events = await listTabEvents()
    expect(events.map((e) => e.kind)).toEqual(['recordOn', 'recordOn', 'recordOff'])
    expect(events[2].time).toBeUndefined()
  })
})
