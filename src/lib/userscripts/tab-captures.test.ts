// 接口采样落进 tab_events（与标签页存续轴事件同表）之后的行为：按页一次读回、随页删除，
// 以及「两类记录同表但不互相污染」。
// 归属只认 tabSessionId —— 录制按标签页划分，不按站点；同一页导航到哪个 host 都记在同一行下，
// 故记录里没有 host 字段，读侧也没有「按站点查」这条路。
// fake-indexeddb 提供全局 indexedDB；用例间 clearAllForTests 保证隔离。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { NetCaptureRecord } from './tab-record-protocol'
import {
  appendTabCapture,
  appendTabEvent,
  clearAllForTests,
  clearTabActivity,
  listTabEvents,
  listTabTimeline,
  mintTabSession,
} from './runtime-db'

/** 一条采样。tabSessionId 就是归属键，缺省 = 归属不明的老记录 */
function rec(url: string, t: number, tabSessionId?: string): NetCaptureRecord {
  return {
    type: 'fetch',
    url,
    method: 'GET',
    reqHeaders: {},
    reqBody: null,
    status: 200,
    respHeaders: {},
    respBody: '{}',
    t,
    ...(tabSessionId ? { tabSessionId } : {}),
  }
}

beforeEach(async () => {
  await clearAllForTests()
})

describe('接口采样（与存续轴事件同表）', () => {
  it('append / 按页读往返，按采集先后升序、主键自增', async () => {
    const t = await mintTabSession({ tabId: 1, url: 'https://a.test/' })
    await appendTabCapture(rec('https://a.test/1', 1, t))
    await appendTabCapture(rec('https://a.test/2', 2, t))
    const rows = (await listTabTimeline(t)).captures
    expect(rows.map((r) => r.url)).toEqual(['https://a.test/1', 'https://a.test/2'])
    expect(rows[0].id).toBeLessThan(rows[1].id!)
  })

  it('按页隔离：同站点两个标签页各读各的，不串页', async () => {
    const t1 = await mintTabSession({ tabId: 1, url: 'https://a.test/' })
    const t2 = await mintTabSession({ tabId: 2, url: 'https://a.test/' })
    await appendTabCapture(rec('https://a.test/one', 1, t1))
    await appendTabCapture(rec('https://a.test/two', 1, t2))
    expect((await listTabTimeline(t1)).captures.map((r) => r.url)).toEqual(['https://a.test/one'])
    expect((await listTabTimeline(t2)).captures.map((r) => r.url)).toEqual(['https://a.test/two'])
  })

  it('不裁剪：写多少留多少，最早的也在（面板要铺完整时间线）', async () => {
    const t = await mintTabSession({ tabId: 1, url: 'https://ring.test/' })
    const total = 260
    for (let i = 0; i < total; i++) {
      await appendTabCapture(rec(`https://ring.test/${i}`, i, t))
    }
    const { captures } = await listTabTimeline(t)
    expect(captures).toHaveLength(total)
    expect(captures[0].url).toBe('https://ring.test/0')
    expect(captures[captures.length - 1].url).toBe(`https://ring.test/${total - 1}`)
  })

  it('清某一页只清该页：别的页的采样原样', async () => {
    const t1 = await mintTabSession({ tabId: 1, url: 'https://a.test/' })
    const t2 = await mintTabSession({ tabId: 2, url: 'https://b.test/' })
    await appendTabCapture(rec('https://a.test/1', 1, t1))
    await appendTabCapture(rec('https://b.test/1', 1, t2))

    await clearTabActivity([t1])

    expect(await listTabTimeline(t1)).toEqual({
      events: [],
      captures: [],
      runs: [],
      acts: [],
      errors: [],
    })
    expect((await listTabTimeline(t2)).captures.map((r) => r.url)).toEqual(['https://b.test/1'])
  })

  it('清某一页时采样与存续轴事件一起走（同表一次清完）', async () => {
    const t = await mintTabSession({ tabId: 1, url: 'https://a.test/' })
    await appendTabEvent(t, 'reload', 'https://a.test/')
    await appendTabCapture(rec('https://a.test/1', 1, t))

    await clearTabActivity([t])

    expect(await listTabTimeline(t)).toEqual({
      events: [],
      captures: [],
      runs: [],
      acts: [],
      errors: [],
    })
    expect(await listTabEvents()).toEqual([])
  })

  it('缺归属键的采样：按页读不到（不进 by_tabSessionId 索引），清全部时一并带走', async () => {
    const t = await mintTabSession({ tabId: 1, url: 'https://a.test/' })
    await appendTabCapture(rec('https://a.test/orphan', 1))
    await appendTabCapture(rec('https://a.test/kept', 2, t))

    expect((await listTabTimeline(t)).captures.map((r) => r.url)).toEqual(['https://a.test/kept'])

    expect(await clearTabActivity()).toBe(true)
    // 再清一次已无东西可删 → 说明那条按页读不到的孤儿也被带走了
    expect(await clearTabActivity()).toBe(false)

    expect(await listTabTimeline(t)).toEqual({
      events: [],
      captures: [],
      runs: [],
      acts: [],
      errors: [],
    })
  })
})

describe('按页读整根活动轴（五类分流）', () => {
  it('事件与采样各自成组，只捞本页', async () => {
    const t1 = await mintTabSession({ tabId: 1, url: 'https://a.test/' })
    const t2 = await mintTabSession({ tabId: 2, url: 'https://b.test/' })
    await appendTabEvent(t1, 'reload', 'https://a.test/')
    await appendTabEvent(t1, 'url', 'https://a.test/next')
    await appendTabEvent(t2, 'reload', 'https://b.test/')
    await appendTabCapture(rec('https://a.test/api', 5, t1))
    await appendTabCapture(rec('https://b.test/api', 5, t2))

    const one = await listTabTimeline(t1)
    expect(one.events.map((e) => e.kind)).toEqual(['reload', 'url'])
    expect(one.events.every((e) => e.tabSessionId === t1)).toBe(true)
    expect(one.captures.map((r) => r.url)).toEqual(['https://a.test/api'])
  })

  it('采样不算事件：listTabEvents 里一条都看不到', async () => {
    const t = await mintTabSession({ tabId: 1, url: 'https://a.test/' })
    await appendTabCapture(rec('https://a.test/1', 1, t))
    expect(await listTabEvents()).toEqual([])
    expect((await listTabTimeline(t)).captures).toHaveLength(1)
  })
})

describe('删一页 / 清全部：采样与事件一起走', () => {
  it('删某一页：它的事件与采样一并没了，别的页原样', async () => {
    const t1 = await mintTabSession({ tabId: 1, url: 'https://a.test/' })
    const t2 = await mintTabSession({ tabId: 2, url: 'https://b.test/' })
    await appendTabCapture(rec('https://a.test/1', 1, t1))
    await appendTabEvent(t1, 'reload', 'https://a.test/')
    await appendTabCapture(rec('https://b.test/1', 1, t2))
    await appendTabEvent(t2, 'reload', 'https://b.test/')

    await clearTabActivity([t1])

    expect(await listTabTimeline(t1)).toEqual({
      events: [],
      captures: [],
      runs: [],
      acts: [],
      errors: [],
    })
    const other = await listTabTimeline(t2)
    expect(other.events.map((e) => e.kind)).toEqual(['reload'])
    expect(other.captures).toHaveLength(1)
  })

  it('清全部：两样都没了（不留孤儿）', async () => {
    const t = await mintTabSession({ tabId: 1, url: 'https://a.test/' })
    await appendTabCapture(rec('https://a.test/1', 1, t))
    await appendTabEvent(t, 'reload', 'https://a.test/')

    expect(await clearTabActivity()).toBe(true)

    expect(await listTabTimeline(t)).toEqual({
      events: [],
      captures: [],
      runs: [],
      acts: [],
      errors: [],
    })
    expect(await listTabEvents()).toEqual([])
  })
})
