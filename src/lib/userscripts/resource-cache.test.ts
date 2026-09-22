// resource-cache.ts 单测：@resource 的抓取、缓存命中与失败降级。
// fake-indexeddb 提供全局 indexedDB，fetch 用 stub（不真发请求）。
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearResourceCache, fetchResourceSources, getResourceCache } from './resource-cache'

const fetchMock = vi.fn()

/** 造一个响应：body 是字节，content-type 可指定 */
function resp(body: string, contentType = 'text/plain'): Response {
  return new Response(body, { headers: { 'content-type': contentType } })
}

beforeEach(async () => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  await clearResourceCache().catch(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchResourceSources', () => {
  it('抓取：文本与 data URI 同一次响应里都取出（mime 去掉 charset 参数）', async () => {
    fetchMock.mockResolvedValue(resp('body { color: red }', 'text/css; charset=utf-8'))
    const out = await fetchResourceSources([{ name: 'css', url: 'https://x.test/a.css' }])

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ name: 'css', ok: true, text: 'body { color: red }' })
    expect(out[0]!.dataUrl).toBe(`data:text/css;base64,${btoa('body { color: red }')}`)
  })

  it('缓存命中：第二次调用不再发请求（url 不变即命中、永不过期）', async () => {
    fetchMock.mockResolvedValue(resp('once'))
    await fetchResourceSources([{ name: 'a', url: 'https://x.test/a.txt' }])
    const second = await fetchResourceSources([{ name: 'a', url: 'https://x.test/a.txt' }])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(second[0]).toMatchObject({ ok: true, text: 'once' })
  })

  it('HTTP 非 2xx：该条 ok=false 且不抛（不让一条失败阻断整批）', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))
    const out = await fetchResourceSources([
      { name: 'bad', url: 'https://x.test/missing.png' },
      { name: 'never', url: 'https://x.test/never.png' },
    ])

    expect(out[0]).toMatchObject({ name: 'bad', ok: false, error: 'HTTP 404' })
    expect(out[0]!.dataUrl).toBeUndefined()
    // 第一条失败不影响第二条继续抓（这里 mock 恒定 404，故第二条也失败）
    expect(out).toHaveLength(2)
  })

  it('网络异常：同样 ok=false 不抛', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const out = await fetchResourceSources([{ name: 'x', url: 'https://x.test/x' }])

    expect(out[0]).toMatchObject({ name: 'x', ok: false, error: 'boom' })
    expect(out[0]!.text).toBeUndefined()
  })

  it('空声明：直接返回空数组，不发请求', async () => {
    await expect(fetchResourceSources([])).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('getResourceCache', () => {
  it('按 url 缓存记录（mime / base64 / text 都在），未命中的 url 不出现在结果里', async () => {
    fetchMock.mockResolvedValue(resp('hello', 'text/plain'))
    await fetchResourceSources([{ name: 'hi', url: 'https://x.test/hi.txt' }])

    const hit = await getResourceCache(['https://x.test/hi.txt', 'https://x.test/none.txt'])
    expect([...hit.keys()]).toEqual(['https://x.test/hi.txt'])
    expect(hit.get('https://x.test/hi.txt')).toMatchObject({ mime: 'text/plain', text: 'hello' })
  })
})
