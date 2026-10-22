import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OffscreenPush } from './chat-ipc'

class FakeChannel {
  static instances: FakeChannel[] = []
  listeners = new Set<(event: MessageEvent) => void>()
  constructor(public name: string) {
    FakeChannel.instances.push(this)
  }
  postMessage(data: unknown): void {
    for (const other of FakeChannel.instances) {
      if (other === this || other.name !== this.name) continue
      for (const listener of other.listeners) listener({ data } as MessageEvent)
    }
  }
  addEventListener(_type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener)
  }
  removeEventListener(_type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener)
  }
}

async function fresh(): Promise<typeof import('./chat-chunk-broadcast')> {
  vi.resetModules()
  return import('./chat-chunk-broadcast')
}

function push(seq = 1): OffscreenPush {
  const chunk = { type: 'text-delta', id: 't', delta: 'hi' } as unknown as OffscreenPush['chunk']
  return { kind: 'chat:chunk', conversationId: 'c1', seq, chunk }
}

beforeEach(() => {
  FakeChannel.instances.length = 0
  vi.stubGlobal('BroadcastChannel', FakeChannel)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BroadcastChannel 通道', () => {
  it('publish 后订阅方收到同一条 chunk', async () => {
    const { publishChatChunk, subscribeChatChunk } = await fresh()
    const got: OffscreenPush[] = []
    subscribeChatChunk((p) => got.push(p))

    publishChatChunk(push())

    expect(got).toHaveLength(1)
    expect(got[0]?.seq).toBe(1)
  })

  it('不是 chat:chunk 的报文被忽略', async () => {
    const { subscribeChatChunk } = await fresh()
    const got: unknown[] = []
    subscribeChatChunk((p) => got.push(p))

    new FakeChannel('duoling:chat-chunk').postMessage({ kind: 'data:changed' })

    expect(got).toHaveLength(0)
  })

  it('退订后不再收到', async () => {
    const { publishChatChunk, subscribeChatChunk } = await fresh()
    const got: OffscreenPush[] = []
    const off = subscribeChatChunk((p) => got.push(p))

    off()
    publishChatChunk(push())

    expect(got).toHaveLength(0)
  })
})

describe('降级：没有 BroadcastChannel', () => {
  it('publish 走 runtime.sendMessage，subscribe 走 onMessage', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const listeners = new Set<(raw: unknown) => void>()
    const sendMessage = vi.fn(() => Promise.resolve())
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
        onMessage: {
          addListener: (fn: (raw: unknown) => void) => listeners.add(fn),
          removeListener: (fn: (raw: unknown) => void) => listeners.delete(fn),
        },
      },
    })

    const { publishChatChunk, subscribeChatChunk } = await fresh()
    const got: OffscreenPush[] = []
    const off = subscribeChatChunk((p) => got.push(p))

    publishChatChunk(push(3))
    expect(sendMessage).toHaveBeenCalledWith(push(3))

    for (const fn of listeners) fn(push(3))
    expect(got).toHaveLength(1)

    off()
    expect(listeners.size).toBe(0)
  })

  it('既无 BroadcastChannel 也无 chrome：订阅退化为空操作，publish 不抛', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const { publishChatChunk, subscribeChatChunk } = await fresh()

    expect(() => publishChatChunk(push())).not.toThrow()
    expect(() => subscribeChatChunk(() => {})()).not.toThrow()
  })
})
