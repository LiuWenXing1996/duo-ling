// net-recorder.ts / net-forwarder.ts 单测：两段模板都是字符串源码（分别注入 MAIN / USER_SCRIPT 世界），
// 这里用最小假 window 把真源码跑起来，验证 fetch / XHR 采集、鉴权头剥离、长度封顶与转发件中继。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NET_BODY_LIMIT } from './net-record-protocol'
import { buildNetForwarderSource } from './net-forwarder'
import { buildNetRecorderSource } from './net-recorder'

type AnyWin = Record<string, unknown>

/** 最小假 XHR：open/setRequestHeader/send + 事件表；send 内同步触发 load（模拟已完成请求） */
class FakeXHR {
  method = ''
  url = ''
  headers: Record<string, string> = {}
  status = 200
  responseType = ''
  responseText = '{"ok":true}'
  private handlers: Record<string, Array<() => void>> = {}
  open(m: string, u: string): void {
    this.method = m
    this.url = u
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value
  }
  getAllResponseHeaders(): string {
    return 'content-type: application/json\r\nx-api-key: secret\r\n'
  }
  addEventListener(type: string, fn: () => void): void {
    ;(this.handlers[type] ||= []).push(fn)
  }
  send(): void {
    for (const fn of this.handlers['load'] || []) fn()
  }
}

function createFakeWindow(origFetch: (input: unknown, init?: unknown) => Promise<Response>): AnyWin {
  const win: AnyWin = {
    location: { origin: 'https://page.test', href: 'https://page.test/app' },
    postMessage: () => {},
    fetch: origFetch,
    XMLHttpRequest: FakeXHR,
  }
  // 捕获 postMessage 的载荷（保持原签名 (data, targetOrigin)）
  const posted: unknown[] = []
  win.postMessage = (data: unknown) => {
    posted.push(data)
  }
  ;(win as { __posted?: unknown[] }).__posted = posted
  return win
}

function postedOf(win: AnyWin): Array<{ __dlNetCapture: true; capture: Record<string, unknown> }> {
  return ((win as { __posted?: unknown[] }).__posted ?? []) as Array<{ __dlNetCapture: true; capture: Record<string, unknown> }>
}

async function waitFor(fn: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
}

function runRecorder(win: AnyWin): void {
  new Function('window', buildNetRecorderSource())(win)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('dl-net-recorder（MAIN 捕获件）', () => {
  it('fetch：捕获 url / method / status / 响应结构摘要，鉴权头剥离', async () => {
    const origFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 0, data: { list: [{ id: 1, name: 'a' }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
        }),
    )
    const win = createFakeWindow(origFetch)
    runRecorder(win)

    const res = (await (win.fetch as (u: string, i?: unknown) => Promise<Response>)('https://api.test/users', {
      headers: { Authorization: 'Bearer t', Accept: 'application/json' },
    })) as Response
    // 页面拿到的响应必须原样（非阻塞采样）
    expect(await res.clone().text()).toContain('"code":0')

    await waitFor(() => postedOf(win).length > 0)
    const post = postedOf(win)[0]
    expect(post.__dlNetCapture).toBe(true)
    const c = post.capture
    expect(c).toMatchObject({ type: 'fetch', url: 'https://api.test/users', method: 'GET', status: 200 })
    expect(c.reqHeaders).toEqual({ accept: 'application/json' }) // Authorization 被剥
    expect(c.respHeaders).toEqual({ 'content-type': 'application/json' }) // x-api-key 被剥
    expect(String(c.respBody)).toContain('data:') // 结构摘要（非原文）
  })

  it('fetch POST：请求体采样进 reqBody，二进制标 [binary]', async () => {
    const origFetch = vi.fn(async () => new Response('ok', { status: 200 }))
    const win = createFakeWindow(origFetch)
    runRecorder(win)

    await (win.fetch as (u: string, i?: unknown) => Promise<Response>)('https://api.test/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ u: 'x', p: 'y' }),
    })
    await waitFor(() => postedOf(win).length > 0)
    expect(postedOf(win)[0].capture.reqBody).toBe('{"u":"x","p":"y"}')
    expect(postedOf(win)[0].capture.method).toBe('POST')

    const win2 = createFakeWindow(origFetch)
    runRecorder(win2)
    await (win2.fetch as (u: string, i?: unknown) => Promise<Response>)('https://api.test/up', {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
    })
    await waitFor(() => postedOf(win2).length > 0)
    expect(postedOf(win2)[0].capture.reqBody).toBe('[binary]')
  })

  it('fetch：响应体采样封顶 NET_BODY_LIMIT', async () => {
    const big = 'x'.repeat(NET_BODY_LIMIT * 3)
    const origFetch = vi.fn(async () => new Response(big, { status: 200 }))
    const win = createFakeWindow(origFetch)
    runRecorder(win)
    await (win.fetch as (u: string, i?: unknown) => Promise<Response>)('https://api.test/big')
    await waitFor(() => postedOf(win).length > 0)
    expect(String(postedOf(win)[0].capture.respBody).length).toBe(NET_BODY_LIMIT)
  })

  it('XHR：捕获方法 / url / 请求头（剥鉴权）/ 请求体 / 状态 / 响应摘要', async () => {
    const win = createFakeWindow(async () => new Response('unused'))
    runRecorder(win)

    const XhrCtor = win.XMLHttpRequest as new () => FakeXHR & { open(m: string, u: string): void; setRequestHeader(n: string, v: string): void; send(b?: unknown): void }
    const xhr = new XhrCtor()
    xhr.open('POST', 'https://api.test/login')
    xhr.setRequestHeader('Authorization', 'Bearer t')
    xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.send('{"u":1}')

    await waitFor(() => postedOf(win).length > 0)
    const c = postedOf(win)[0].capture
    expect(c).toMatchObject({ type: 'xhr', url: 'https://api.test/login', method: 'POST', status: 200 })
    expect(c.reqHeaders).toEqual({ 'content-type': 'application/json' }) // 键归一为小写，Authorization 被剥
    expect(c.reqBody).toBe('{"u":1}')
    expect(c.respHeaders).toEqual({ 'content-type': 'application/json' }) // x-api-key 被剥
    expect(String(c.respBody)).toContain('ok')
  })

  it('fetch 失败（reject）也补一条记录并原样抛错', async () => {
    const origFetch = vi.fn(async () => {
      throw new Error('network down')
    })
    const win = createFakeWindow(origFetch)
    runRecorder(win)
    await expect((win.fetch as (u: string) => Promise<Response>)('https://api.test/x')).rejects.toThrow('network down')
    await waitFor(() => postedOf(win).length > 0)
    expect(postedOf(win)[0].capture.status).toBe(0)
  })

  it('重复注入只包一层（幂等守卫）', async () => {
    const origFetch = vi.fn(async () => new Response('ok', { status: 200 }))
    const win = createFakeWindow(origFetch)
    runRecorder(win)
    runRecorder(win) // 第二次应被 window.__dlNetRecorder 挡下
    await (win.fetch as (u: string) => Promise<Response>)('https://api.test/x')
    await waitFor(() => postedOf(win).length > 0)
    await new Promise((r) => setTimeout(r, 20))
    expect(postedOf(win)).toHaveLength(1)
  })
})

describe('dl-net-forwarder（USER_SCRIPT 转发件）', () => {
  it('把同帧的采集消息转给 SW，并带上本帧 hostname', () => {
    const listeners: Array<(e: { source: unknown; data: unknown }) => void> = []
    const win: AnyWin = {
      location: { hostname: 'shop.test' },
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        if (type === 'message') listeners.push(fn as (e: { source: unknown; data: unknown }) => void)
      },
    }
    const sendMessage = vi.fn()
    ;(globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage, lastError: undefined } }
    try {
      new Function('window', buildNetForwarderSource())(win)
      const capture = { type: 'fetch', url: 'https://api.shop.test/x', method: 'GET' }
      for (const fn of listeners) fn({ source: win, data: { __dlNetCapture: true, capture } })
      expect(sendMessage).toHaveBeenCalledWith({ __dlNetCapture: true, host: 'shop.test', capture }, expect.any(Function))
    } finally {
      delete (globalThis as { chrome?: unknown }).chrome
    }
  })

  it('忽略非本帧 / 非本协议的消息', () => {
    const listeners: Array<(e: { source: unknown; data: unknown }) => void> = []
    const win: AnyWin = {
      location: { hostname: 'shop.test' },
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        if (type === 'message') listeners.push(fn as (e: { source: unknown; data: unknown }) => void)
      },
    }
    const sendMessage = vi.fn()
    ;(globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage, lastError: undefined } }
    try {
      new Function('window', buildNetForwarderSource())(win)
      for (const fn of listeners) fn({ source: {}, data: { __dlNetCapture: true, capture: {} } }) // 非本帧
      for (const fn of listeners) fn({ source: win, data: { other: 1 } }) // 非本协议
      expect(sendMessage).not.toHaveBeenCalled()
    } finally {
      delete (globalThis as { chrome?: unknown }).chrome
    }
  })
})
