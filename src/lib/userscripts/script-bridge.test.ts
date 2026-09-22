// 脚本主世界桥 · 协议全链路测试。
//
// script-bridge（MAIN 世界侧）与 script-relay（USER_SCRIPT 世界侧）都是字符串模板源码，
// 这里用最小假 frame 把两端接在同一个"窗口"上跑真源码，验证握手、请求-应答、防伪校验
// 与下行事件转发。chrome.runtime 用最小桩替代（sendMessage 同步回调、connect 给可手动
// 触发 onMessage 的 Port）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildScriptBridgeSource } from './script-bridge'
import { buildScriptRelaySource } from './script-relay'

const SECRET = 'test-secret-0123456789abcdef'
const UUID = 'uuid-1111-2222'

type MsgListener = (ev: { source: unknown; data: unknown }) => void

interface BridgeApi {
  call: (req: unknown) => Promise<unknown>
  connect: (connId: string) => Promise<void>
  onEvent: (fn: (ev: unknown) => void) => void
}

/**
 * 最小假 frame：message 监听表 + 同步 postMessage 投递（真实 postMessage 是异步广播，
 * 这里同步广播给全部监听器，语义等价且免去等一拍的噪声）。
 * `posted` 记录本窗口发出过的全部消息，供重放类用例取料。
 */
function createFakeWindow(): { win: any; posted: unknown[] } {
  const messageListeners = new Set<MsgListener>()
  const posted: unknown[] = []
  const win = {
    location: { origin: 'https://page.test' },
    addEventListener(type: string, fn: MsgListener) {
      if (type === 'message') messageListeners.add(fn)
    },
    removeEventListener(type: string, fn: MsgListener) {
      if (type === 'message') messageListeners.delete(fn)
    },
    postMessage(data: unknown) {
      posted.push(data)
      const ev = { source: win, data }
      for (const fn of [...messageListeners]) fn(ev)
    },
  }
  return { win, posted }
}

interface PortStub {
  name: string
  emit: (m: unknown) => void
}

/** 最小 chrome.runtime 桩：sendMessage 同步回调；connect 返回可手动 emit 的 Port */
function createChromeStub(handler: (msg: any) => unknown): {
  chrome: unknown
  sent: any[]
  ports: PortStub[]
} {
  const sent: any[] = []
  const ports: PortStub[] = []
  const chrome = {
    runtime: {
      lastError: undefined as unknown,
      sendMessage(msg: any, cb: (resp: unknown) => void) {
        sent.push(msg)
        cb(handler(msg))
      },
      connect({ name }: { name: string }) {
        const listeners = new Set<(m: unknown) => void>()
        const port: PortStub = {
          name,
          emit(m: unknown) {
            for (const fn of [...listeners]) fn(m)
          },
        }
        ports.push(port)
        return {
          name,
          onMessage: { addListener: (fn: (m: unknown) => void) => listeners.add(fn) },
          onDisconnect: { addListener: () => {} },
        }
      },
    },
  }
  return { chrome, sent, ports }
}

function runRelay(src: string, win: any, chromeStub: unknown): void {
  new Function('window', 'chrome', src)(win, chromeStub)
}

// 客户端源码是表达式（IIFE），以 `var x = <源码>` 形式求值后取出返回的 API 对象
function runBridge(src: string, win: any): BridgeApi {
  return new Function('window', `var __api = ${src}; return __api`)(win)
}

function setup(opts?: {
  handler?: (msg: any) => unknown
  relaySecret?: string
  withRelay?: boolean
}) {
  const { win, posted } = createFakeWindow()
  const stub = createChromeStub(opts?.handler ?? (() => ({ ok: true, data: 'ok' })))
  if (opts?.withRelay !== false) {
    runRelay(buildScriptRelaySource(opts?.relaySecret ?? SECRET), win, stub.chrome)
  }
  const api = runBridge(buildScriptBridgeSource(SECRET, UUID), win)
  return { win, posted, api, stub }
}

describe('脚本主世界桥（bridge + relay 真源码对跑）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('call 经中继件转发到扩展侧，响应原样带回', async () => {
    const { api, stub } = setup({ handler: () => ({ ok: true, data: { v: 1 } }) })

    await expect(api.call({ c: 'store.get', key: 'k' })).resolves.toEqual({
      ok: true,
      data: { v: 1 },
    })
    expect(stub.sent).toHaveLength(1)
    expect(stub.sent[0]).toMatchObject({
      __dl: true,
      uuid: UUID,
      req: { c: 'store.get', key: 'k' },
    })
  })

  it('响应里的 ok:false 原样交给调用方（桥只做传输，不解释语义）', async () => {
    const { api } = setup({ handler: () => ({ ok: false, error: '没这个键', code: 'NOT_FOUND' }) })

    await expect(api.call({ c: 'store.get' })).resolves.toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    })
  })

  it('中继件缺失：握手超时并报可读错误，而不是让首次调用白等 30s', async () => {
    const { api } = setup({ withRelay: false })

    const pending = api.call({ c: 'store.get' })
    const assertion = expect(pending).rejects.toMatchObject({ code: 'BRIDGE_UNAVAILABLE' })
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
  })

  it('中继件密钥不同源：不认外来件，同样落到握手超时', async () => {
    const { api } = setup({ relaySecret: 'another-secret-entirely' })

    const pending = api.call({ c: 'store.get' })
    const assertion = expect(pending).rejects.toMatchObject({ code: 'BRIDGE_UNAVAILABLE' })
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
  })

  it('伪造 proof 的请求被中继件丢弃（页面冒充脚本提权走不通）', async () => {
    const { win, stub } = setup()

    win.postMessage({
      __dlBridge: 1,
      kind: 'req',
      uuid: UUID,
      seq: 1,
      proof: 'deadbeef',
      req: { c: 'cookie.list' },
    })
    await Promise.resolve()
    expect(stub.sent).toHaveLength(0)
  })

  it('重放已经用过的 seq 被丢弃（录下旧帧也复用不了）', async () => {
    const { win, posted, api, stub } = setup()
    await api.call({ c: 'store.get', key: 'k' })

    const reqMsg = posted.find((m: any) => m && m.kind === 'req') as Record<string, unknown>
    expect(reqMsg).toBeTruthy()
    const before = stub.sent.length

    win.postMessage({ ...reqMsg })
    await Promise.resolve()
    expect(stub.sent).toHaveLength(before)
  })

  it('connId 缺省时中继件不建 Port（只有显式 connect 才占下行通道）', async () => {
    const { api, stub } = setup()
    await api.call({ c: 'store.get' })
    expect(stub.ports).toHaveLength(0)
  })

  it('connect 后 SW 推送经中继件转为下行事件', async () => {
    const { api, stub } = setup()
    const seen: unknown[] = []
    api.onEvent((ev) => seen.push(ev))

    await api.connect('conn-1')
    expect(stub.ports).toHaveLength(1)
    expect(stub.ports[0]!.name).toBe(`duoling:dl:${UUID}:conn-1`)

    stub.ports[0]!.emit({ __dlApiEvent: true, ev: { t: 'port.ready' } })
    expect(seen).toEqual([{ t: 'port.ready' }])
  })

  it('中继件拿不到扩展 API 时回 RELAY_UNAVAILABLE（配置问题要报出来，不能静默）', async () => {
    const { win } = createFakeWindow()
    // runtime 在、sendMessage 不在 —— 对应「世界没开 messaging」的配置缺失
    runRelay(buildScriptRelaySource(SECRET), win, { runtime: { lastError: undefined } })
    const api = runBridge(buildScriptBridgeSource(SECRET, UUID), win)

    await expect(api.call({ c: 'store.get' })).resolves.toMatchObject({
      ok: false,
      code: 'RELAY_UNAVAILABLE',
    })
  })
})
