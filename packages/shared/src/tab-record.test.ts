// tab-record.ts 单测：入站载荷归一化（SW 的信任边界）、鉴权头剥离、URL 凭据脱敏。
import { describe, expect, it } from 'vitest'
import {
  NET_BODY_LIMIT,
  NET_MASK,
  NET_QUERY_VALUE_MAX,
  normalizeNetCapture,
  stripAuthHeaders,
  stripUrlSecrets,
} from './tab-record'

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

describe('normalizeNetCapture', () => {
  /** 归属的存续行 id 由 SW 给定（载荷里没有），用例统一填同一个值 */
  const SID = 'sess-1'

  it('非法载荷一律返回 null（不落库）', () => {
    expect(normalizeNetCapture('', SID)).toBeNull()
    expect(normalizeNetCapture(null, SID)).toBeNull()
    expect(normalizeNetCapture('nope', SID)).toBeNull()
    expect(normalizeNetCapture({ type: 'ws', url: 'u' }, SID)).toBeNull()
    expect(normalizeNetCapture({ type: 'fetch' }, SID)).toBeNull() // 缺 url
  })

  it('收窄字段：method 大写、status/t 取整、非字符串头丢弃、鉴权头再剥一次', () => {
    const r = normalizeNetCapture(
      {
        type: 'fetch',
        url: 'https://api.test/users',
        method: 'post',
        reqHeaders: { Authorization: 'x', accept: 'application/json', 'x-num': 5 },
        reqBody: 'a'.repeat(NET_BODY_LIMIT + 10),
        status: 201.9,
        respHeaders: { 'set-cookie': 'sid=1', 'content-type': 'application/json' },
        respBody: '[binary]',
        t: 1234.7,
      },
      SID,
    )
    expect(r).toMatchObject({
      tabSessionId: SID,
      type: 'fetch',
      url: 'https://api.test/users',
      method: 'POST',
      status: 201,
      t: 1234,
      respBody: '[binary]',
    })
    expect(r).not.toHaveProperty('host') // 录制按标签页，记录上没有站点字段
    expect(r!.reqHeaders).toEqual({ accept: 'application/json' }) // 鉴权头被剥、非字符串值被丢
    expect(r!.reqBody!.length).toBe(NET_BODY_LIMIT) // 请求体采样封顶
    expect(r!.respHeaders).toEqual({ 'content-type': 'application/json' }) // set-cookie 被剥
  })

  it('缺省字段兜底：method 默认 GET、status 默认 0、t 默认当前时刻、无体为 null', () => {
    const before = Date.now()
    const r = normalizeNetCapture({ type: 'xhr', url: 'u' }, SID)
    expect(r).toMatchObject({
      type: 'xhr',
      method: 'GET',
      status: 0,
      reqBody: null,
      respBody: null,
    })
    expect(r!.t).toBeGreaterThanOrEqual(before)
  })

  it('归属缺位时不写字段（清全部时才带走的那些记录）', () => {
    const r = normalizeNetCapture({ type: 'fetch', url: 'https://a.test/x' })
    expect(r).not.toBeNull()
    expect(r).not.toHaveProperty('tabSessionId')
  })

  it('落库前 URL 凭据已脱敏（与剥鉴权头同级的信任边界）', () => {
    const r = normalizeNetCapture(
      { type: 'fetch', url: 'https://a.test/api/me?access_token=secret-value&page=1' },
      SID,
    )
    expect(r!.url).toBe(`https://a.test/api/me?access_token=${NET_MASK}&page=1`)
  })
})
