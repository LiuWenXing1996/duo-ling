import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceptLink, connectLink, Link } from './link'
import { LINK_CHANNEL, LinkError, isLinkFrame } from './link-frame'
import { createServiceClient, serveService } from './link-service'

class FakePort {
  peer: FakePort | null = null
  private alive = true
  private readonly messageHandlers: Array<(raw: unknown) => void> = []
  private readonly disconnectHandlers: Array<() => void> = []

  constructor(readonly name: string) {}

  readonly onMessage = {
    addListener: (listener: (raw: unknown) => void): void => {
      this.messageHandlers.push(listener)
    },
  }

  readonly onDisconnect = {
    addListener: (listener: () => void): void => {
      this.disconnectHandlers.push(listener)
    },
  }

  postMessage(message: unknown): void {
    if (!this.alive) throw new Error('Attempting to use a disconnected port object')
    const peer = this.peer
    queueMicrotask(() => {
      if (peer?.alive) for (const handler of peer.messageHandlers) handler(message)
    })
  }

  disconnect(): void {
    if (!this.alive) return
    this.alive = false
    for (const handler of this.disconnectHandlers) handler()
    this.peer?.disconnect()
  }
}

function installRuntime(): void {
  const listeners = new Set<(port: FakePort) => void>()
  vi.stubGlobal('chrome', {
    runtime: {
      connect(info: { name: string }): FakePort {
        const client = new FakePort(info.name)
        const server = new FakePort(info.name)
        client.peer = server
        server.peer = client
        queueMicrotask(() => {
          for (const listener of listeners) listener(server)
        })
        return client
      },
      onConnect: {
        addListener: (listener: (port: FakePort) => void): void => {
          listeners.add(listener)
        },
        removeListener: (listener: (port: FakePort) => void): void => {
          listeners.delete(listener)
        },
      },
    },
  })
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function pair(handlers: Record<string, (payload: unknown) => unknown> = {}): Promise<{
  sw: Link
  off: Link
}> {
  const sw = acceptLink({ handlers, heartbeatMs: 0 })
  const off = connectLink({ heartbeatMs: 0 })
  await off.whenReady(200)
  await sw.whenReady(200)
  return { sw, off }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('帧判别', () => {
  it('只认哨兵字段（UI 的广播报文不会被误收）', () => {
    expect(isLinkFrame({ ch: LINK_CHANNEL, t: 'evt', type: 'chat:running' })).toBe(true)
    expect(isLinkFrame({ kind: 'chat:running', conversationId: 'c1' })).toBe(false)
    expect(isLinkFrame({ ok: true, data: 1 })).toBe(false)
    expect(isLinkFrame(null)).toBe(false)
    expect(isLinkFrame('duoling:link')).toBe(false)
  })
})

describe('连接与 hello', () => {
  it('offscreen 发起、SW 接收：hello 往返后两端都算就绪', async () => {
    installRuntime()
    const { sw, off } = await pair()
    expect(off.isOpen).toBe(true)
    expect(sw.isOpen).toBe(true)
  })

  it('SW 侧在 hello 到达前不算就绪', async () => {
    installRuntime()
    const sw = acceptLink({ heartbeatMs: 0 })
    expect(sw.isOpen).toBe(false)
    await expect(sw.whenReady(30)).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('onOpen 在每次 hello 往返后触发（重连后靠它补状态）', async () => {
    installRuntime()
    const sw = acceptLink({ heartbeatMs: 0 })
    let opened = 0
    sw.onOpen(() => {
      opened += 1
    })
    const off = connectLink({ heartbeatMs: 0 })
    await off.whenReady(200)
    await flush()
    expect(opened).toBe(1)
  })

  it('无连接时请求直接拒为 TRANSPORT（不当成超时）', async () => {
    installRuntime()
    const lonely = new Link({ role: 'offscreen', heartbeatMs: 0 })
    await expect(lonely.request('greet')).rejects.toMatchObject({ code: 'TRANSPORT' })
  })
})

describe('请求-应答', () => {
  it('载荷与返回值原样过线', async () => {
    installRuntime()
    const { off } = await pair({ greet: (payload) => `hi ${String(payload)}` })
    await expect(off.request('greet', 'a')).resolves.toBe('hi a')
  })

  it('对端没有这个 type → NO_HANDLER', async () => {
    installRuntime()
    const { off } = await pair()
    await expect(off.request('nope')).rejects.toMatchObject({ code: 'NO_HANDLER' })
  })

  it('handler 抛错 → REMOTE，且保留原文案', async () => {
    installRuntime()
    const { off } = await pair({
      boom: () => {
        throw new Error('脚本不存在')
      },
    })
    await expect(off.request('boom')).rejects.toMatchObject({
      code: 'REMOTE',
      message: '脚本不存在',
    })
  })

  it('超时 → TIMEOUT（不并进 TRANSPORT：重试写会重复执行）', async () => {
    installRuntime()
    const { off } = await pair({ slow: () => new Promise(() => {}) })
    await expect(off.request('slow', undefined, { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
  })

  it('迟到的应答不会二次结算（超时后已从 pending 摘掉）', async () => {
    installRuntime()
    const box: { release: ((value: string) => void) | null } = { release: null }
    const { off } = await pair({
      slow: () => new Promise<string>((resolve) => (box.release = resolve)),
    })
    await expect(off.request('slow', undefined, { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
    box.release?.('迟到')
    await flush()

    expect(off.isOpen).toBe(true)
  })
})

describe('断线', () => {
  it('端口断开时未决请求立刻拒为 TRANSPORT', async () => {
    installRuntime()
    const { off } = await pair({ slow: () => new Promise(() => {}) })
    const pending = off.request('slow', undefined, { timeoutMs: 5_000 })
    const settled = pending.catch((e: unknown) => e)
    await flush()
    off.close()
    const error = await settled
    expect(error).toBeInstanceOf(LinkError)
    expect((error as LinkError).code).toBe('TRANSPORT')
  })

  it('没有连接时 emit 返回 false（事件不排队）', async () => {
    installRuntime()
    const lonely = new Link({ role: 'offscreen', heartbeatMs: 0 })
    expect(lonely.emit('chat:running', { conversationId: 'c1' })).toBe(false)
  })
})

describe('事件', () => {
  it('evt 帧到达订阅方，载荷原样', async () => {
    installRuntime()
    const { sw, off } = await pair()
    const seen: Array<[string, unknown]> = []
    sw.onEvent((type, payload) => seen.push([type, payload]))

    expect(off.emit('chat:running', { conversationId: 'c1' })).toBe(true)
    await flush()

    expect(seen).toEqual([['chat:running', { conversationId: 'c1' }]])
  })
})

describe('服务寻址', () => {
  it('方法名进 payload，参数与返回值按接口走', async () => {
    installRuntime()
    const { sw, off } = await pair()
    const service = {
      fsRead: async (uuid: string) => ({ code: `${uuid}-code` }),
      fsExportZip: async (uuids: string[], meta?: { exporter?: string }) => ({
        zipBase64: `${uuids.length}:${meta?.exporter ?? ''}`,
      }),
    }
    serveService(sw, service)
    const client = createServiceClient<typeof service>(off)

    await expect(client.fsRead('u1')).resolves.toEqual({ code: 'u1-code' })
    await expect(client.fsExportZip(['a', 'b'], { exporter: 'e2e' })).resolves.toEqual({
      zipBase64: '2:e2e',
    })
  })

  it('方法不存在 → NO_HANDLER；代理不是 thenable', async () => {
    installRuntime()
    const { sw, off } = await pair()
    serveService(sw, { fsRead: async () => null })
    const client = createServiceClient<{ fsRead(): Promise<null>; ghost(): Promise<null> }>(off)

    await expect(client.ghost()).rejects.toMatchObject({ code: 'NO_HANDLER' })

    expect((client as unknown as { then?: unknown }).then).toBeUndefined()
  })
})
