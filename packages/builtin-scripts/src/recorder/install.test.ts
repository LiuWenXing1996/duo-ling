// recorder/install.ts + net-probe.ts 单测：件在 MAIN 世界跑（机制框架 + net 种类），
// 这里用最小假 window + 假脚本桥把它跑起来，验证上行信封形状、fetch / XHR 采集、
// 鉴权头剥离与长度封顶。
//
// 机制层与种类层一起测：net-probe 由机制层在安装时挂上，单独跑不起来 ——
// 「机制 + 当前唯一一类」是一次安装的两半。
//
// 注入方式：件读全局 window 与全局 __dlBridge（GM 包装内联的桥），故这里把两者都装成
// 全局再调安装函数（与真注入同一条路径）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NET_BODY_LIMIT, NET_TAB_KIND } from '@duoling/shared'
import { installTabRecorder } from './install'

type AnyWin = Record<string, unknown>

/** 机制层的上行信封（经脚本桥 emit 出去的东西） */
interface Emitted {
  __dlEvent: true
  name: string
  event: { t: 'tab.record'; kind: string; record: Record<string, unknown> }
}

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
    fetch: origFetch,
    XMLHttpRequest: FakeXHR,
  }
  return win
}

async function waitFor(fn: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
}

function runRecorder(win: AnyWin): Emitted[] {
  const emitted: Emitted[] = []
  vi.stubGlobal('window', win)
  // 假脚本桥：只实现件用到的 emit；真形状见 userscript-core 的 script-bridge.ts
  vi.stubGlobal('__dlBridge', {
    emit: (envelope: Emitted) => {
      emitted.push(envelope)
    },
  })
  installTabRecorder()
  return emitted
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dl-tab-recorder（MAIN 捕获件：机制框架 + net 种类）', () => {
  it('fetch：捕获 url / method / status / 响应结构摘要，鉴权头剥离', async () => {
    const origFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 0, data: { list: [{ id: 1, name: 'a' }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
        }),
    )
    const win = createFakeWindow(origFetch)
    const emitted = runRecorder(win)

    const res = (await (win.fetch as (u: string, i?: unknown) => Promise<Response>)('https://api.test/users', {
      headers: { Authorization: 'Bearer t', Accept: 'application/json' },
    })) as Response
    // 页面拿到的响应必须原样（非阻塞采样）
    expect(await res.clone().text()).toContain('"code":0')

    await waitFor(() => emitted.length > 0)
    const post = emitted[0]
    // 上行信封：机制层拼 __dlEvent + tab.record，种类件只给 record
    expect(post.__dlEvent).toBe(true)
    expect(post.event.t).toBe('tab.record')
    expect(post.event.kind).toBe(NET_TAB_KIND)
    const c = post.event.record
    expect(c).toMatchObject({ type: 'fetch', url: 'https://api.test/users', method: 'GET', status: 200 })
    expect(c.reqHeaders).toEqual({ accept: 'application/json' }) // Authorization 被剥
    expect(c.respHeaders).toEqual({ 'content-type': 'application/json' }) // x-api-key 被剥
    expect(String(c.respBody)).toContain('data:') // 结构摘要（非原文）
  })

  it('fetch POST：请求体采样进 reqBody，二进制标 [binary]', async () => {
    const origFetch = vi.fn(async () => new Response('ok', { status: 200 }))
    const win = createFakeWindow(origFetch)
    const emitted = runRecorder(win)

    await (win.fetch as (u: string, i?: unknown) => Promise<Response>)('https://api.test/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ u: 'x', p: 'y' }),
    })
    await waitFor(() => emitted.length > 0)
    expect(emitted[0].event.record.reqBody).toBe('{"u":"x","p":"y"}')
    expect(emitted[0].event.record.method).toBe('POST')

    const win2 = createFakeWindow(origFetch)
    const emitted2 = runRecorder(win2)
    await (win2.fetch as (u: string, i?: unknown) => Promise<Response>)('https://api.test/up', {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
    })
    await waitFor(() => emitted2.length > 0)
    expect(emitted2[0].event.record.reqBody).toBe('[binary]')
  })

  it('fetch：响应体采样封顶 NET_BODY_LIMIT', async () => {
    const big = 'x'.repeat(NET_BODY_LIMIT * 3)
    const origFetch = vi.fn(async () => new Response(big, { status: 200 }))
    const win = createFakeWindow(origFetch)
    const emitted = runRecorder(win)
    await (win.fetch as (u: string) => Promise<Response>)('https://api.test/big')
    await waitFor(() => emitted.length > 0)
    expect(String(emitted[0].event.record.respBody).length).toBe(NET_BODY_LIMIT)
  })

  it('XHR：捕获方法 / url / 请求头（剥鉴权）/ 请求体 / 状态 / 响应摘要', async () => {
    const win = createFakeWindow(async () => new Response('unused'))
    const emitted = runRecorder(win)

    const XhrCtor = win.XMLHttpRequest as new () => FakeXHR & { open(m: string, u: string): void; setRequestHeader(n: string, v: string): void; send(b?: unknown): void }
    const xhr = new XhrCtor()
    xhr.open('POST', 'https://api.test/login')
    xhr.setRequestHeader('Authorization', 'Bearer t')
    xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.send('{"u":1}')

    await waitFor(() => emitted.length > 0)
    const post = emitted[0]
    expect(post.event.kind).toBe(NET_TAB_KIND)
    const c = post.event.record
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
    const emitted = runRecorder(win)
    await expect((win.fetch as (u: string) => Promise<Response>)('https://api.test/x')).rejects.toThrow('network down')
    await waitFor(() => emitted.length > 0)
    expect(emitted[0].event.record.status).toBe(0)
  })

  it('重复注入只包一层（幂等守卫）', async () => {
    const origFetch = vi.fn(async () => new Response('ok', { status: 200 }))
    const win = createFakeWindow(origFetch)
    const emitted = runRecorder(win)
    runRecorder(win) // 第二次应被 window.__dlTabRecorder 挡下（幂等守卫在，不发也不报错）
    await (win.fetch as (u: string) => Promise<Response>)('https://api.test/x')
    await waitFor(() => emitted.length > 0)
    await new Promise((r) => setTimeout(r, 20))
    expect(emitted).toHaveLength(1)
  })

  it('桥不可用（emit 抛错）时静默丢弃，不影响页面 fetch', async () => {
    const origFetch = vi.fn(async () => new Response('ok', { status: 200 }))
    const win = createFakeWindow(origFetch)
    vi.stubGlobal('window', win)
    vi.stubGlobal('__dlBridge', {
      emit: () => {
        throw new Error('bridge down')
      },
    })
    installTabRecorder()
    const res = (await (win.fetch as (u: string) => Promise<Response>)('https://api.test/x')) as Response
    expect(res.status).toBe(200) // 页面请求照常完成
  })
})
