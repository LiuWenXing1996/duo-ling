// net-record-protocol.ts 单测：入站载荷归一化（SW 的信任边界）、鉴权头剥离、
// URL 凭据脱敏、host 归一化与 match pattern（跨上下文共用的纯函数）。
import { describe, expect, it } from 'vitest'
import {
  NET_BODY_LIMIT,
  NET_MASK,
  NET_QUERY_VALUE_MAX,
  hostFromUrl,
  hostToMatchPattern,
  normalizeCapture,
  normalizeHost,
  stripAuthHeaders,
  stripUrlSecrets,
} from './net-record-protocol'

describe('normalizeHost', () => {
  it('小写、去空白、去首尾点', () => {
    expect(normalizeHost('  Example.COM  ')).toBe('example.com')
    expect(normalizeHost('.a.test.')).toBe('a.test')
  })

  it('容忍完整 URL 与端口', () => {
    expect(normalizeHost('https://api.example.com/v1/users?x=1')).toBe('api.example.com')
    expect(normalizeHost('example.com:8443')).toBe('example.com')
  })

  it('非法输入返回空串', () => {
    expect(normalizeHost('')).toBe('')
    expect(normalizeHost('   ')).toBe('')
    expect(normalizeHost('has space.com')).toBe('')
    expect(normalizeHost('a/b')).toBe('')
  })

  it('保留内网主机名里的下划线', () => {
    expect(normalizeHost('my_host.internal')).toBe('my_host.internal')
  })
})

describe('hostToMatchPattern', () => {
  it('生成覆盖 http/https 的 pattern', () => {
    expect(hostToMatchPattern('example.com')).toBe('*://example.com/*')
  })
})

describe('hostFromUrl', () => {
  it('从页面 URL 取归一化 host', () => {
    expect(hostFromUrl('https://www.example.com/a/b?c=1')).toBe('www.example.com')
  })

  it('缺位 / 非法 URL 返回空串（不抛）', () => {
    expect(hostFromUrl(undefined)).toBe('')
    expect(hostFromUrl('')).toBe('')
    expect(hostFromUrl('not a url')).toBe('')
  })

  it('非 http(s) 协议返回空串（录制件本来也注入不了）', () => {
    expect(hostFromUrl('chrome://extensions')).toBe('')
    expect(hostFromUrl('file:///tmp/a.html')).toBe('')
  })
})

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

describe('stripUrlSecrets', () => {
  it('敏感键名换值不换名：下划线 / 连字符 / 驼峰都命中', () => {
    expect(stripUrlSecrets('https://a.test/p?access_token=abc&x-api-key=k&apiKey=k2&t=1')).toBe(
      `https://a.test/p?access_token=${NET_MASK}&x-api-key=${NET_MASK}&apiKey=${NET_MASK}&t=1`,
    )
  })

  it('超长值一律换掉，分页 / 筛选这类短值留着', () => {
    const long = 'a'.repeat(NET_QUERY_VALUE_MAX + 1)
    expect(stripUrlSecrets(`https://a.test/p?page=2&page_size=10&track=${long}`)).toBe(
      `https://a.test/p?page=2&page_size=10&track=${NET_MASK}`,
    )
  })

  it('不误伤形近键名（keyword / search / booking）', () => {
    const url = 'https://a.test/p?keyword=hello&search=x&booking=1'
    expect(stripUrlSecrets(url)).toBe(url)
  })

  it('无改动时字符级原样返回（不引入 URL 规范化）', () => {
    expect(stripUrlSecrets('https://a.test/p?page=1')).toBe('https://a.test/p?page=1')
    expect(stripUrlSecrets('https://a.test')).toBe('https://a.test')
  })

  it('fragment：k=v 形态脱敏，路由形态原样放行', () => {
    expect(stripUrlSecrets('https://a.test/cb#access_token=xyz')).toBe(
      `https://a.test/cb#access_token=${NET_MASK}`,
    )
    expect(stripUrlSecrets('https://a.test/#/route/user')).toBe('https://a.test/#/route/user')
  })

  it('非法 URL 原样返回（不抛）', () => {
    expect(stripUrlSecrets('not a url')).toBe('not a url')
    expect(stripUrlSecrets('')).toBe('')
  })

  it('编码过的值按解码后长度判定', () => {
    const encoded = encodeURIComponent('a'.repeat(NET_QUERY_VALUE_MAX + 1))
    expect(stripUrlSecrets(`https://a.test/p?q=${encoded}`)).toBe(`https://a.test/p?q=${NET_MASK}`)
  })

  it('真实形态回归：埋着设备标识的统计上报 URL 被脱敏', () => {
    // 结构取自真实 GA 上报（值换成假值），当初就是这条把 cid 原样存进了库
    const url =
      'https://www.google-analytics.com/g/collect?v=2&tid=G-ABCDEF1234' +
      '&cid=12345678.1234567890&gtm=45je69g1v893655145za200zd893655145xf1' +
      '&_p=1789903269818&dl=https%3A%2F%2Fexample.com%2F&dt=Example&gcd=13l3l3l3l1l1'
    expect(stripUrlSecrets(url)).toBe(
      'https://www.google-analytics.com/g/collect?v=2&tid=G-ABCDEF1234' +
        `&cid=${NET_MASK}&gtm=${NET_MASK}` +
        '&_p=1789903269818&dl=https%3A%2F%2Fexample.com%2F&dt=Example&gcd=13l3l3l3l1l1',
    )
  })

  it('真实形态回归：业务接口的分页 / 筛选参数一个都不动', () => {
    const url =
      'https://rebang.today/api/latest-list?tab=top&sub_tab=lasthour&page=1&page_size=10&list_mode=2'
    expect(stripUrlSecrets(url)).toBe(url)
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

  it('落库前 URL 凭据已脱敏（与剥鉴权头同级的信任边界）', () => {
    const r = normalizeCapture('a.test', {
      type: 'fetch',
      url: 'https://a.test/api/me?access_token=secret-value&page=1',
    })
    expect(r!.url).toBe(`https://a.test/api/me?access_token=${NET_MASK}&page=1`)
  })
})
