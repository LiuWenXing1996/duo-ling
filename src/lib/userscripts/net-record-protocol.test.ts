// net-record-protocol.ts 单测：入站载荷归一化（SW 的信任边界）与鉴权头剥离。
import { describe, expect, it } from 'vitest'
import { NET_BODY_LIMIT, normalizeCapture, stripAuthHeaders } from './net-record-protocol'

describe('stripAuthHeaders', () => {
  it('剥掉鉴权头（大小写不敏感），保留其余', () => {
    const out = stripAuthHeaders({
      Authorization: 'Bearer t',
      Cookie: 'a=1',
      'content-type': 'application/json',
      'X-Api-Key': 'k',
      accept: 'application/json',
    })
    expect(out).toEqual({ 'content-type': 'application/json', accept: 'application/json' })
  })
})

describe('normalizeCapture', () => {
  it('非法载荷一律返回 null（不落库）', () => {
    expect(normalizeCapture('', { type: 'fetch', url: 'u' })).toBeNull()
    expect(normalizeCapture('example.com', null)).toBeNull()
    expect(normalizeCapture('example.com', 'nope')).toBeNull()
    expect(normalizeCapture('example.com', { type: 'ws', url: 'u' })).toBeNull()
    expect(normalizeCapture('example.com', { type: 'fetch' })).toBeNull() // 缺 url
  })

  it('收窄字段：host 小写、method 大写、status/t 取整、非字符串头丢弃、鉴权头再剥一次', () => {
    const r = normalizeCapture('Example.COM', {
      type: 'fetch',
      url: 'https://api.test/users',
      method: 'post',
      reqHeaders: { Authorization: 'x', accept: 'application/json', 'x-num': 5 },
      reqBody: 'a'.repeat(NET_BODY_LIMIT + 10),
      status: 201.9,
      respHeaders: { 'set-cookie': 'sid=1', 'content-type': 'application/json' },
      respBody: '[binary]',
      t: 1234.7,
    })
    expect(r).toMatchObject({
      host: 'example.com',
      type: 'fetch',
      url: 'https://api.test/users',
      method: 'POST',
      status: 201,
      t: 1234,
      respBody: '[binary]',
    })
    expect(r!.reqHeaders).toEqual({ accept: 'application/json' }) // 鉴权头被剥、非字符串值被丢
    expect(r!.reqBody!.length).toBe(NET_BODY_LIMIT) // 请求体采样封顶
    expect(r!.respHeaders).toEqual({ 'content-type': 'application/json' }) // set-cookie 被剥
  })

  it('缺省字段兜底：method 默认 GET、status 默认 0、t 默认当前时刻、无体为 null', () => {
    const before = Date.now()
    const r = normalizeCapture('h.com', { type: 'xhr', url: 'u' })
    expect(r).toMatchObject({ host: 'h.com', type: 'xhr', method: 'GET', status: 0, reqBody: null, respBody: null })
    expect(r!.t).toBeGreaterThanOrEqual(before)
  })
})
