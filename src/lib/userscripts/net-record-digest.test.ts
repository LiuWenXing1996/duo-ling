// net-record-digest.ts 单测：接口去重与两档语料压缩。
//
// 纯函数直测（零依赖、无 IDB）：摘要档要控在 2KB 内且**不静默截断**（得交代还剩多少），
// 全量档要能逐条取到采样体——两条都是喂给模型的文本，压缩错了模型就跟着错。
import { describe, expect, it } from 'vitest'
import type { NetCaptureRecord } from './net-record-protocol'
import {
  CAPTURE_DIGEST_MAX_CHARS,
  CAPTURE_FULL_MAX_RECORDS,
  collapseRoutes,
  describeCaptureDigest,
  describeCaptureRecords,
  routeOf,
} from './net-record-digest'

function rec(partial: Partial<NetCaptureRecord> = {}): NetCaptureRecord {
  return {
    host: 'example.com',
    type: 'fetch',
    url: 'https://example.com/api/list',
    method: 'GET',
    reqHeaders: {},
    reqBody: null,
    status: 200,
    respHeaders: {},
    respBody: null,
    t: 1_000,
    ...partial,
  }
}

describe('routeOf', () => {
  it('保留路径，查询串只留键名（值折叠）', () => {
    expect(routeOf('https://x.test/api/list?page=2&size=20')).toBe('/api/list?page=…&size=…')
    expect(routeOf('https://x.test/api/detail')).toBe('/api/detail')
  })

  it('无查询串时不留问号', () => {
    expect(routeOf('https://x.test/a')).toBe('/a')
  })

  it('非绝对 URL 原样截断（不抛）', () => {
    expect(routeOf('/relative/path')).toBe('/relative/path')
    expect(routeOf('x'.repeat(500)).length).toBeLessThanOrEqual(161)
  })
})

describe('collapseRoutes', () => {
  it('同 method + 路径去重计数，不同方法分开', () => {
    const routes = collapseRoutes([
      rec({ url: 'https://x.test/a?page=1' }),
      rec({ url: 'https://x.test/a?page=2' }),
      rec({ url: 'https://x.test/a', method: 'POST' }),
    ])
    expect(routes.map((r) => `${r.method} ${r.route} ×${r.count}`)).toEqual([
      'GET /a?page=… ×2',
      'POST /a ×1',
    ])
  })

  it('顺序 = 首次出现顺序（页面请求的先后），struct 取最近一次', () => {
    const routes = collapseRoutes([
      rec({ url: 'https://x.test/first', respBody: '{ a: number }' }),
      rec({ url: 'https://x.test/second', respBody: '{ b: number }' }),
      rec({ url: 'https://x.test/first', respBody: '{ a: string }', status: 500 }),
    ])
    expect(routes.map((r) => r.route)).toEqual(['/first', '/second'])
    expect(routes[0]).toMatchObject({ count: 2, status: 500, structure: '{ a: string }' })
    expect(routes[1].structure).toBe('{ b: number }')
  })
})

describe('describeCaptureDigest', () => {
  it('空数组不产生档位', () => {
    expect(describeCaptureDigest([])).toEqual([])
  })

  it('首行给总数与去重后的接口数，随后逐条列接口', () => {
    const lines = describeCaptureDigest([
      rec({ url: 'https://x.test/api/list', respBody: '{ data: […], total: number }' }),
      rec({ url: 'https://x.test/api/list' }),
      rec({ url: 'https://x.test/api/meta', status: 404 }),
    ])
    expect(lines[0]).toContain('3 条请求')
    expect(lines[0]).toContain('2 个接口')
    expect(lines[1]).toContain('GET /api/list（200，2 次）：{ data: […], total: number }')
    expect(lines[2]).toContain('GET /api/meta（404）')
  })

  it('无响应时状态显示为「无响应」', () => {
    const lines = describeCaptureDigest([rec({ status: 0 })])
    expect(lines[1]).toContain('（无响应）')
  })

  it('超上限即停，并交代还剩多少（不静默截断）', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      rec({ url: `https://x.test/api/endpoint-${i}`, respBody: 'x'.repeat(120) }),
    )
    const lines = describeCaptureDigest(many)
    const text = lines.join('\n')
    expect(text.length).toBeLessThanOrEqual(CAPTURE_DIGEST_MAX_CHARS + 200) // 超限行自身不计入累加
    expect(text).toContain('未列出')
    expect(lines.length).toBeLessThan(many.length)
  })
})

describe('describeCaptureRecords', () => {
  it('空数组返回空串', () => {
    expect(describeCaptureRecords([])).toBe('')
  })

  it('逐条列请求 / 响应（含头与体）', () => {
    const text = describeCaptureRecords([
      rec({
        method: 'POST',
        url: 'https://x.test/api/save',
        reqHeaders: { 'content-type': 'application/json' },
        reqBody: '{"a":1}',
        status: 201,
        respHeaders: { 'content-type': 'application/json' },
        respBody: '{ id: number }',
      }),
    ])
    expect(text).toContain('[1] POST https://x.test/api/save → 201（fetch）')
    expect(text).toContain('请求头：content-type: application/json')
    expect(text).toContain('请求体：{"a":1}')
    expect(text).toContain('响应结构：{ id: number }')
  })

  it('超出条数上限时取最近的，并在开头交代', () => {
    const many = Array.from({ length: CAPTURE_FULL_MAX_RECORDS + 5 }, (_, i) =>
      rec({ url: `https://x.test/api/${i}` }),
    )
    const text = describeCaptureRecords(many)
    expect(text).toContain(`共 ${many.length} 条记录，以下是最近 ${CAPTURE_FULL_MAX_RECORDS} 条`)
    // 取的是最近的一批：最后一条（下标最大）在，第一条不在
    expect(text).toContain(`/api/${many.length - 1}`)
    expect(text).not.toContain('[1] GET https://x.test/api/0 →')
  })

  it('无体的记录不产生空的体行', () => {
    const text = describeCaptureRecords([rec()])
    expect(text).not.toContain('请求体：')
    expect(text).not.toContain('响应结构：')
  })
})
