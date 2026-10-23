// 脚本主世界桥 · 协议全链路测试。
//
// MAIN 侧客户端（gm-bridge-client.ts）与 USER_SCRIPT 侧中继件（builtin/relay/）用最小假 frame 接在同一窗口跑真实现
// chrome.runtime 用最小桩替代（sendMessage 同步回调、connect 给可手动触发 onMessage 的 Port）。
//

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGmBridgeClient } from './gm-bridge-client'
import { installRelay } from '@duoling/user-scripts/builtin/relay'

const SECRET = 'test-secret-0123456789abcdef'
const UUID = 'uuid-1111-2222'

type MsgListener = (ev: { source: unknown; data: unknown }) => void

interface BridgeApi {
  call: (req: unknown, runId?: string) => Promise<unknown>
  connect: (connId: string) => Promise<void>
  emit: (payload: any) => any
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

/** 中继件读全局 window / chrome，故把假货装成全局再安装 */
function runRelay(win: any, chromeStub: unknown, secret: string): void {
  vi.stubGlobal('window', win)
  vi.stubGlobal('chrome', chromeStub)
  installRelay(secret)
}

function setup(opts?: {
  handler?: (msg: any) => unknown
  relaySecret?: string
  withRelay?: boolean
}) {
  const { win, posted } = createFakeWindow()
  const stub = createChromeStub(opts?.handler ?? (() => ({ ok: true, data: 'ok' })))
  if (opts?.withRelay !== false) {
    runRelay(win, stub.chrome, opts?.relaySecret ?? SECRET)
  }
  const api: BridgeApi = createGmBridgeClient(win, SECRET, UUID)
  return { win, posted, api, stub }
}

describe('脚本主世界桥（bridge + relay 真实现对跑）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('call 经中继件转发到扩展侧，响应原样带回', async () => {
    const { api, stub } = setup({ handler: () => ({ ok: true, data: { v: 1 } }) })

    await expect(api.call({ c: 'store.get', key: 'k' })).resolves.toEqual({
      ok: true,
      data: { v: 1 },
    })
    expect(stub.sent).toHaveLength(1)
    expect(stub.sent[0]).toMatchObject({
      __gm: 1,
      kind: 'req',
      uuid: UUID,
      req: { c: 'store.get', key: 'k' },
    })
  })

  it('runId 随请求帧原样带到 SW（观测数据据此归属到具体某次运行）', async () => {
    const { api, stub } = setup({ handler: () => ({ ok: true }) })

    await api.call({ c: 'store.get', key: 'k' }, 'run-42')
    expect(stub.sent[0]).toMatchObject({ __gm: 1, kind: 'req', uuid: UUID, runId: 'run-42' })

    // 不带 runId 的帧：字段为 undefined，SW 侧按「无归属」处理，不崩
    await api.call({ c: 'store.get', key: 'k' })
    expect(stub.sent[1].runId).toBeUndefined()
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
      __gm: 1,
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
    expect(stub.ports[0]!.name).toBe(`duoling:gm:${UUID}:conn-1`)

    stub.ports[0]!.emit({ __gm: 1, kind: 'api', ev: { t: 'port.ready' } })
    expect(seen).toEqual([{ t: 'port.ready' }])
  })

  it('emit 单向上行：运行广播不经握手原样转给扩展侧（fire-and-forget）', () => {
    const { api, stub } = setup({ handler: () => undefined })

    expect(api.emit({ kind: 'runstart', name: '探针', runId: 'r-1' })).toBeUndefined()
    expect(stub.sent).toHaveLength(1)
    expect(stub.sent[0]).toMatchObject({
      __gm: 1,
      kind: 'runstart',
      uuid: UUID,
      name: '探针',
      runId: 'r-1',
    })
  })

  it('emit 的错误上报帧（MAIN 腿 kind: notice）转发成 SW 腿的 kind: ev', () => {
    const { api, stub } = setup({ handler: () => undefined })

    api.emit({
      kind: 'notice',
      name: '探针',
      event: { t: 'error', phase: 'runtime', message: '炸了', url: 'https://page.test/' },
    })
    expect(stub.sent).toHaveLength(1)
    expect(stub.sent[0]).toMatchObject({
      __gm: 1,
      kind: 'ev',
      uuid: UUID,
      event: { t: 'error', message: '炸了' },
    })
  })

  it('伪造 proof 的事件帧被中继件丢弃（单向上行同样过防伪）', () => {
    const { win, stub } = setup({ handler: () => undefined })

    win.postMessage({
      __gm: 1,
      kind: 'notice',
      uuid: UUID,
      seq: 7,
      proof: 'deadbeef',
      name: 'x',
      event: { t: 'error', message: '冒充' },
    })
    expect(stub.sent).toHaveLength(0)
  })

  it('中继件拿不到扩展 API 时回 RELAY_UNAVAILABLE（配置问题要报出来，不能静默）', async () => {
    const { win } = createFakeWindow()
    // runtime 在、sendMessage 不在 —— 对应「世界没开 messaging」的配置缺失
    runRelay(win, { runtime: { lastError: undefined } }, SECRET)
    const api: BridgeApi = createGmBridgeClient(win, SECRET, UUID)

    await expect(api.call({ c: 'store.get' })).resolves.toMatchObject({
      ok: false,
      code: 'RELAY_UNAVAILABLE',
    })
  })
})
