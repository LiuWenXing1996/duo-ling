// netlog-db.ts 单测：网络采集落库、按 host 隔离、环形裁剪与清理。
// fake-indexeddb 提供全局 indexedDB；用例间 clearAllForTests 保证隔离。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { NET_HOST_RING_LIMIT, type NetCaptureRecord } from './net-record-protocol'
import {
  appendCapture,
  clearAllForTests,
  clearCapturesByHost,
  countCapturesByHost,
  listCapturedHosts,
  listCapturesByHost,
} from './netlog-db'

function rec(host: string, url: string, t: number): NetCaptureRecord {
  return {
    host,
    type: 'fetch',
    url,
    method: 'GET',
    reqHeaders: {},
    reqBody: null,
    status: 200,
    respHeaders: {},
    respBody: '{}',
    t,
  }
}

beforeEach(async () => {
  await clearAllForTests()
})

describe('netlog-db', () => {
  it('append / list 往返，按采集先后升序，主键自增', async () => {
    await appendCapture(rec('a.test', 'https://a.test/1', 1))
    await appendCapture(rec('a.test', 'https://a.test/2', 2))
    const rows = await listCapturesByHost('a.test')
    expect(rows.map((r) => r.url)).toEqual(['https://a.test/1', 'https://a.test/2'])
    expect(rows[0].id).toBeLessThan(rows[1].id!)
  })

  it('按 host 隔离，不串站', async () => {
    await appendCapture(rec('a.test', 'https://a.test/1', 1))
    await appendCapture(rec('b.test', 'https://b.test/1', 1))
    expect(await countCapturesByHost('a.test')).toBe(1)
    expect(await countCapturesByHost('b.test')).toBe(1)
    expect((await listCapturesByHost('a.test')).map((r) => r.url)).toEqual(['https://a.test/1'])
  })

  it('环形：超过上限删最旧，只留最近 N 条', async () => {
    const total = NET_HOST_RING_LIMIT + 5
    for (let i = 0; i < total; i++) await appendCapture(rec('ring.test', `https://ring.test/${i}`, i))
    expect(await countCapturesByHost('ring.test')).toBe(NET_HOST_RING_LIMIT)
    const rows = await listCapturesByHost('ring.test')
    // 最旧的 5 条（0..4）被删，剩下 5..total-1
    expect(rows[0].url).toBe('https://ring.test/5')
    expect(rows[rows.length - 1].url).toBe(`https://ring.test/${total - 1}`)
  })

  it('环形裁剪只作用于本 host，不误伤别站', async () => {
    for (let i = 0; i < NET_HOST_RING_LIMIT + 3; i++) await appendCapture(rec('hot.test', `https://hot.test/${i}`, i))
    await appendCapture(rec('cold.test', 'https://cold.test/1', 1))
    expect(await countCapturesByHost('hot.test')).toBe(NET_HOST_RING_LIMIT)
    expect(await countCapturesByHost('cold.test')).toBe(1)
  })

  it('clearCapturesByHost 只清该 host', async () => {
    await appendCapture(rec('a.test', 'https://a.test/1', 1))
    await appendCapture(rec('b.test', 'https://b.test/1', 1))
    await clearCapturesByHost('a.test')
    expect(await countCapturesByHost('a.test')).toBe(0)
    expect(await countCapturesByHost('b.test')).toBe(1)
  })

  it('listCapturedHosts 去重枚举已录 host', async () => {
    await appendCapture(rec('a.test', 'https://a.test/1', 1))
    await appendCapture(rec('a.test', 'https://a.test/2', 2))
    await appendCapture(rec('b.test', 'https://b.test/1', 1))
    expect(await listCapturedHosts()).toEqual(['a.test', 'b.test'])
  })

  it('空库：list 返回空数组、count 为 0', async () => {
    expect(await listCapturesByHost('nope.test')).toEqual([])
    expect(await countCapturesByHost('nope.test')).toBe(0)
    expect(await listCapturedHosts()).toEqual([])
  })
})
