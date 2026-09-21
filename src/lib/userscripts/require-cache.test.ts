import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getRequireCache, setRequireCache, clearRequireCache, fetchRequireSources } from './require-cache'

describe('require-cache', () => {
  beforeEach(async () => {
    await clearRequireCache().catch(() => {})
  })

  it('setRequireCache 后 getRequireCache 命中', async () => {
    await setRequireCache([{ url: 'https://a.test/lib.js', code: 'console.log(1)' }])
    const m = await getRequireCache(['https://a.test/lib.js'])
    expect(m.get('https://a.test/lib.js')).toBe('console.log(1)')
  })

  it('getRequireCache 未命中返回空 map', async () => {
    const m = await getRequireCache(['https://missing.test/x.js'])
    expect(m.size).toBe(0)
  })

  it('setRequireCache 覆盖同 url', async () => {
    await setRequireCache([{ url: 'https://a.test/lib.js', code: 'v1' }])
    await setRequireCache([{ url: 'https://a.test/lib.js', code: 'v2' }])
    const m = await getRequireCache(['https://a.test/lib.js'])
    expect(m.get('https://a.test/lib.js')).toBe('v2')
  })

  it('clearRequireCache 清空', async () => {
    await setRequireCache([{ url: 'https://a.test/lib.js', code: 'x' }])
    await clearRequireCache()
    const m = await getRequireCache(['https://a.test/lib.js'])
    expect(m.size).toBe(0)
  })
})

describe('fetchRequireSources', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('命中缓存时不调 fetch', async () => {
    await setRequireCache([{ url: 'https://a.test/lib.js', code: 'cached' }])
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await fetchRequireSources(['https://a.test/lib.js'])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res).toEqual([{ url: 'https://a.test/lib.js', ok: true, code: 'cached' }])
  })

  it('未命中时抓取成功并写缓存（保序）', async () => {
    const fetchMock = vi.fn(async (u: string) => {
      const code = u.includes('a.test') ? 'codeA' : u.includes('b.test') ? 'codeB' : 'codeX'
      return new Response(code, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const urls = ['https://a.test/1.js', 'https://b.test/2.js', 'https://c.test/3.js']
    const res = await fetchRequireSources(urls)
    expect(res.map((r) => r.ok)).toEqual([true, true, true])
    expect(res.map((r) => r.code)).toEqual(['codeA', 'codeB', 'codeX'])
    expect(res.map((r) => r.url)).toEqual(urls)
    // 写缓存后再次抓取走缓存，fetch 不再被调用
    await fetchRequireSources(urls)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('HTTP 非 2xx 返回 ok:false 且不带 code', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await fetchRequireSources(['https://a.test/x.js'])
    expect(res[0].ok).toBe(false)
    expect(res[0].error).toBe('HTTP 404')
    expect(res[0].code).toBeUndefined()
  })

  it('fetch 抛错返回 ok:false 且不向上抛', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('net down')
    })
    vi.stubGlobal('fetch', fetchMock)
    const res = await fetchRequireSources(['https://a.test/x.js'])
    expect(res[0].ok).toBe(false)
    expect(res[0].error).toBe('net down')
  })

  it('空数组直接返回空', async () => {
    expect(await fetchRequireSources([])).toEqual([])
  })
})
