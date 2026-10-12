// 接口采样落进 tab_events（与标签页存续轴事件同表）之后的行为：按页一次读回、按站点清、
// 同事务随页删除，以及「两类记录同表但不互相污染」。
// fake-indexeddb 提供全局 indexedDB；用例间 clearAllForTests 保证隔离。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { NetCaptureRecord } from './net-record-protocol'
import {
  appendTabCapture,
  appendTabEvent,
  clearAllForTests,
  clearTabActivity,
  clearTabCapturesByHost,
  listTabCapturesByHost,
  listTabEvents,
  listTabTimeline,
  mintTabSession,
} from './runtime-db'

function rec(host: string, url: string, t: number, tabSessionId?: string): NetCaptureRecord {
  return {
    host,
    sessionId: 'sess-1',
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
  it('append / 按站点读往返，按采集先后升序、主键自增', async () => {
    await appendTabCapture(rec('a.test', 'https://a.test/1', 1))
    await appendTabCapture(rec('a.test', 'https://a.test/2', 2))
    const rows = await listTabCapturesByHost('a.test')
    expect(rows.map((r) => r.url)).toEqual(['https://a.test/1', 'https://a.test/2'])
    expect(rows[0].id).toBeLessThan(rows[1].id!)
  })

  it('按站点隔离，不串站', async () => {
    await appendTabCapture(rec('a.test', 'https://a.test/1', 1))
    await appendTabCapture(rec('b.test', 'https://b.test/1', 1))
    expect((await listTabCapturesByHost('a.test')).map((r) => r.url)).toEqual(['https://a.test/1'])
    expect((await listTabCapturesByHost('b.test')).map((r) => r.url)).toEqual(['https://b.test/1'])
  })

  it('不裁剪：写多少留多少，最早的也在（面板要铺完整时间线）', async () => {
    const total = 260
    for (let i = 0; i < total; i++) {
      await appendTabCapture(rec('ring.test', `https://ring.test/${i}`, i))
    }
    const rows = await listTabCapturesByHost('ring.test')
    expect(rows).toHaveLength(total)
    expect(rows[0].url).toBe('https://ring.test/0')
    expect(rows[rows.length - 1].url).toBe(`https://ring.test/${total - 1}`)
  })

  it('清某站点只清采样：这一页的存续轴事件不受影响', async () => {
    const t = await mintTabSession({ tabId: 1, url: 'https://a.test/' })
    await appendTabEvent(t, 'reload', 'https://a.test/')
    await appendTabCapture(rec('a.test', 'https://a.test/1', 1, t))
    await appendTabCapture(rec('b.test', 'https://b.test/1', 1))

    await clearTabCapturesByHost('a.test')

    expect(await listTabCapturesByHost('a.test')).toEqual([])
    expect(await listTabCapturesByHost('b.test')).toHaveLength(1)
    expect((await listTabEvents()).map((e) => e.kind)).toEqual(['reload'])
  })

  it('缺归属键的采样：按站点查得到，按页查不到（不进 by_tabSessionId 索引）', async () => {
    const t = await mintTabSession({ tabId: 1, url: 'https://a.test/' })
    await appendTabCapture(rec('a.test', 'https://a.test/old', 1))
    await appendTabCapture(rec('a.test', 'https://a.test/new', 2, t))

    expect((await listTabCapturesByHost('a.test')).map((r) => r.url)).toEqual([
      'https://a.test/old',
      'https://a.test/new',
    ])
    expect((await listTabTimeline(t)).captures.map((r) => r.url)).toEqual(['https://a.test/new'])
  })
})

describe('按页读整条时间线（两类记录分流）', () => {
  it('事件与采样各自成组，只捞本页', async () => {
    const t1 = await mintTabSession({ tabId: 1, url: 'https://a.test/' })
    const t2 = await mintTabSession({ tabId: 2, url: 'https://b.test/' })
    await appendTabEvent(t1, 'reload', 'https://a.test/')
    await appendTabEvent(t1, 'url', 'https://a.test/next')
    await appendTabEvent(t2, 'reload', 'https://b.test/')
    await appendTabCapture(rec('a.test', 'https://a.test/api', 5, t1))
    await appendTabCapture(rec('b.test', 'https://b.test/api', 5, t2))

    const one = await listTabTimeline(t1)
    expect(one.events.map((e) => e.kind)).toEqual(['reload', 'url'])
    expect(one.events.every((e) => e.tabSessionId === t1)).toBe(true)
    expect(one.captures.map((r) => r.url)).toEqual(['https://a.test/api'])
  })

  it('采样不算事件：listTabEvents 里一条都看不到', async () => {
    const t = await mintTabSession({ tabId: 1, url: 'https://a.test/' })
    await appendTabCapture(rec('a.test', 'https://a.test/1', 1, t))
    expect(await listTabEvents()).toEqual([])
    expect((await listTabTimeline(t)).captures).toHaveLength(1)
  })
})

describe('删一页 / 清全部：采样与事件一起走', () => {
  it('删某一页：它的事件与采样一并没了，别的页原样', async () => {
    const t1 = await mintTabSession({ tabId: 1, url: 'https://a.test/' })
    const t2 = await mintTabSession({ tabId: 2, url: 'https://b.test/' })
    await appendTabCapture(rec('a.test', 'https://a.test/1', 1, t1))
    await appendTabEvent(t1, 'reload', 'https://a.test/')
    await appendTabCapture(rec('b.test', 'https://b.test/1', 1, t2))
    await appendTabEvent(t2, 'reload', 'https://b.test/')

    await clearTabActivity([t1])

    expect(await listTabTimeline(t1)).toEqual({ events: [], captures: [] })
    const other = await listTabTimeline(t2)
    expect(other.events.map((e) => e.kind)).toEqual(['reload'])
    expect(other.captures).toHaveLength(1)
  })

  it('清全部：两样都没了（不留孤儿）', async () => {
    const t = await mintTabSession({ tabId: 1, url: 'https://a.test/' })
    await appendTabCapture(rec('a.test', 'https://a.test/1', 1, t))
    await appendTabEvent(t, 'reload', 'https://a.test/')

    expect(await clearTabActivity()).toBe(true)

    expect(await listTabTimeline(t)).toEqual({ events: [], captures: [] })
    expect(await listTabCapturesByHost('a.test')).toEqual([])
  })
})
