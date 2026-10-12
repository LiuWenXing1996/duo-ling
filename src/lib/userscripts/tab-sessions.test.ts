// tab-sessions / runtime 库 tab_sessions 表单测：记录开关、被动取号、盖章、启动划断、环形裁剪。
// 全走 fake-indexeddb，用例间 clearAllForTests 清库保证隔离。
//
// 刻意不断言「具体时刻是多少」—— 时刻一律「记得到就记」，测的是「有没有记、记到什么程度」：
// 记得到就必须有值，记不到就必须缺省（不许拿别的时刻顶上）。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearAllForTests, listTabSessions, seedTabSessionsForTests } from './runtime-db'
import {
  noteTabClosed,
  noteTabUrl,
  recordingTabSessionId,
  setTabRecording,
  splitTabSessionsAtBrowserStart,
} from './tab-sessions'
import { TAB_SESSION_MAX } from './types'

beforeEach(async () => {
  await clearAllForTests()
})

/** 按 tabId 取那一行（表里同一 tabId 至多一行未结束的） */
async function rowOf(tabId: number) {
  return (await listTabSessions()).find((r) => r.tabId === tabId)
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

    await noteTabUrl(4, 'https://b.example/p')
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
