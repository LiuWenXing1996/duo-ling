// 反向中继协议全链路测试（notes/content/userscript-page-relay.md）。
//
// page-stub / page-client 都是字符串模板（分别注入 MAIN / USER_SCRIPT 世界），
// 这里用最小假 frame（事件表 + 同步 postMessage）把两端接在同一"窗口"上跑真源码，
// 验证握手、信封、事件转发与 fetch 钩子的完整行为。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPageStubSource } from './page-stub'
import { buildPageClientSource } from './page-client'

const SECRET = 'test-secret-0123456789abcdef'

type MsgListener = (ev: { source: unknown; data: unknown }) => void

/** 最小假 frame：message 监听表 + 同步 postMessage 投递 + 可替换 fetch（结构宽松，win 用 any 规避逐字段类型） */
function createFakeWindow(origFetch: (...args: unknown[]) => Promise<Response>): any {
  const messageListeners = new Set<MsgListener>()
  const domListeners = new Map<string, Set<{ fn: (ev: unknown) => void; once: boolean }>>()
  const win = {
    location: { origin: 'https://page.test' },
    addEventListener(type: string, fn: (ev: unknown) => void, opts?: { once?: boolean }) {
      if (type === 'message') {
        messageListeners.add(fn as MsgListener)
        return
      }
      if (!domListeners.has(type)) domListeners.set(type, new Set())
      domListeners.get(type)!.add({ fn, once: opts?.once === true })
    },
    removeEventListener(type: string, fn: (ev: unknown) => void) {
      if (type === 'message') {
        messageListeners.delete(fn as MsgListener)
        return
      }
      const set = domListeners.get(type)
      if (set) for (const item of [...set]) if (item.fn === fn) set.delete(item)
    },
    postMessage(data: unknown) {
      const ev = { source: win, data }
      for (const fn of [...messageListeners]) fn(ev)
    },
    dispatchDom(type: string, event: Record<string, unknown>) {
      const set = domListeners.get(type)
      if (!set) return
      for (const item of [...set]) {
        item.fn(event)
        if (item.once) set.delete(item)
      }
    },
    fetch: origFetch as unknown,
  }
  return win
}

function runStub(src: string, win: ReturnType<typeof createFakeWindow>): void {
  new Function('window', src)(win)
}

// 客户端源码是表达式（IIFE），以 `var x = <源码>` 形式求值后取出返回的 API 对象
function runClient(src: string, win: ReturnType<typeof createFakeWindow>): {
  listen: (type: string, handler: (ev: unknown) => void, opts?: object) => Promise<() => Promise<void>>
  hook: (name: 'fetch', handler: (call: unknown) => unknown) => Promise<() => Promise<void>>
} {
  return new Function('window', `var __api = ${src}; return __api`)(win)
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('page relay 协议（stub + client 真源码对跑）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function setup(opts?: { clientSecret?: string }) {
    const origFetch = vi.fn(() => Promise.resolve(new Response('orig-body', { status: 200 })))
    const win = createFakeWindow(origFetch)
    runStub(buildPageStubSource(SECRET), win)
    const api = runClient(buildPageClientSource(opts?.clientSecret ?? SECRET), win)
    return { win, api, origFetch }
  }

  it('握手成功后 listen 收到事件摘要，off() 后不再收到', async () => {
    const { win, api } = await setup()
    const seen: unknown[] = []
    const off = await api.listen('click', (ev) => seen.push(ev))

    win.dispatchDom('click', { type: 'click', timeStamp: 42, detail: { x: 1 } })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: 'click', timeStamp: 42, detail: { x: 1 } })

    await off()
    win.dispatchDom('click', { type: 'click', timeStamp: 43 })
    expect(seen).toHaveLength(1)
  })

  it('once 选项：命中一次后自动注销', async () => {
    const { win, api } = await setup()
    const seen: unknown[] = []
    await api.listen('click', (ev) => seen.push(ev), { once: true })

    win.dispatchDom('click', { type: 'click', timeStamp: 1 })
    win.dispatchDom('click', { type: 'click', timeStamp: 2 })
    expect(seen).toHaveLength(1)
  })

  it('selector 过滤：target 命中才转发', async () => {
    const { win, api } = await setup()
    const seen: unknown[] = []
    const hitTarget = {
      matches: (s: string) => s === '#btn',
      closest: () => null,
    }
    const missTarget = {
      matches: () => false,
      closest: () => null,
    }
    await api.listen('click', (ev) => seen.push(ev), { selector: '#btn' })

    win.dispatchDom('click', { type: 'click', timeStamp: 1, target: missTarget })
    expect(seen).toHaveLength(0)
    win.dispatchDom('click', { type: 'click', timeStamp: 2, target: hitTarget })
    expect(seen).toHaveLength(1)
  })

  it('密钥不符：握手校验失败 reject HANDSHAKE_FAILED', async () => {
    const { api } = await setup({ clientSecret: 'wrong-secret' })
    await expect(api.listen('click', () => {})).rejects.toMatchObject({ code: 'HANDSHAKE_FAILED' })
  })

  it('hook fetch：respond 动作由 stub 构造 Response，原 fetch 不被调用', async () => {
    const { win, api, origFetch } = await setup()
    const off = await api.hook('fetch', () => ({ action: 'respond', status: 201, body: 'fake-body' }))

    const res = (await win.fetch('https://x.test/api')) as Response
    expect(res.status).toBe(201)
    expect(await res.text()).toBe('fake-body')
    expect(origFetch).not.toHaveBeenCalled()

    await off()
    const res2 = (await win.fetch('https://x.test/api')) as Response
    expect(await res2.text()).toBe('orig-body')
    expect(origFetch).toHaveBeenCalledTimes(1)
  })

  it('hook fetch：passthrough 透传原调用参数', async () => {
    const { win, api, origFetch } = await setup()
    await api.hook('fetch', (call) => {
      expect((call as { url: string }).url).toBe('https://x.test/api')
      return { action: 'passthrough' }
    })
    await win.fetch('https://x.test/api', { method: 'POST' })
    expect(origFetch).toHaveBeenCalledWith('https://x.test/api', { method: 'POST' })
  })

  it('hook fetch：脚本 500ms 内未裁决自动放行（宁失效不阻塞）', async () => {
    const { win, api, origFetch } = await setup()
    await api.hook('fetch', () => new Promise(() => {})) // 永不裁决

    const pending = win.fetch('https://x.test/api') as Promise<Response>
    await vi.advanceTimersByTimeAsync(500)
    const res = await pending
    expect(await res.text()).toBe('orig-body')
    expect(origFetch).toHaveBeenCalledTimes(1)
  })

  it('hook fetch：脚本裁决函数抛错按 passthrough 兜底', async () => {
    const { win, api, origFetch } = await setup()
    await api.hook('fetch', () => {
      throw new Error('boom')
    })
    const res = (await win.fetch('https://x.test/api')) as Response
    expect(await res.text()).toBe('orig-body')
    expect(origFetch).toHaveBeenCalledTimes(1)
  })

  it('多会话钩子按后进先出摘除', async () => {
    const win = createFakeWindow(() => Promise.resolve(new Response('orig', { status: 200 })))
    runStub(buildPageStubSource(SECRET), win)
    const a = runClient(buildPageClientSource(SECRET), win)
    const b = runClient(buildPageClientSource(SECRET), win)

    const offA = await a.hook('fetch', () => ({ action: 'respond', status: 200, body: 'from-a' }))
    const offB = await b.hook('fetch', () => ({ action: 'respond', status: 200, body: 'from-b' }))

    // b 后钩，顶层是 b 的 wrapper
    const res1 = (await win.fetch('https://x.test/')) as Response
    expect(await res1.text()).toBe('from-b')

    // a 在栈中段，不能先摘
    await expect(offA()).rejects.toThrow()
    // 摘掉 b 后回到 a 的 wrapper
    await offB()
    const res2 = (await win.fetch('https://x.test/')) as Response
    expect(await res2.text()).toBe('from-a')
    // 再摘 a 回到原始 fetch
    await offA()
    const res3 = (await win.fetch('https://x.test/')) as Response
    expect(res3.status).toBe(200)
  })
})
