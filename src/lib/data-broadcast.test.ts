// data-broadcast 单测：通道选型（BroadcastChannel / 降级）、载荷形状、合并节流、退订。
//
// 模块的 rx / tx 是模块级单例，故每个用例前 vi.resetModules() 拿全新实例，
// 否则「上一个用例已创建过 channel」会让降级路径根本走不到。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataChangedPush } from '@/shared/extension-ipc'

/** 内存版 BroadcastChannel：同频道互发，**不回发给发送实例**（与浏览器一致） */
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

async function fresh(): Promise<typeof import('@/lib/data-broadcast')> {
  vi.resetModules()
  return import('@/lib/data-broadcast')
}

beforeEach(() => {
  FakeChannel.instances.length = 0
  vi.stubGlobal('BroadcastChannel', FakeChannel)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('BroadcastChannel 通道', () => {
  it('订阅者收到「域 + uuid」，且**不带数据**', async () => {
    const { subscribeDataChange, broadcastDataChange } = await fresh()
    const got: DataChangedPush[] = []
    subscribeDataChange((p) => got.push(p))

    broadcastDataChange('script', 'u1')

    expect(got).toHaveLength(1)
    expect(got[0].kind).toBe('data:changed')
    expect(got[0].domain).toBe('script')
    expect(got[0].uuid).toBe('u1')
    // 关键：只通知「哪条变了」，数据由接收方回拉，杜绝第二份真相
    expect(Object.keys(got[0]).sort()).toEqual(['at', 'domain', 'kind', 'uuid'])
  })

  it('同域不同 uuid 各自投递（互不合并）', async () => {
    const { subscribeDataChange, broadcastDataChange } = await fresh()
    const got: DataChangedPush[] = []
    subscribeDataChange((p) => got.push(p))

    broadcastDataChange('script', 'a')
    broadcastDataChange('script', 'b')
    broadcastDataChange('script') // uuid 缺省 = 全量变化，单独计

    expect(got.map((p) => p.uuid)).toEqual(['a', 'b', undefined])
  })

  it('退订后不再收到', async () => {
    const { subscribeDataChange, broadcastDataChange } = await fresh()
    const got: DataChangedPush[] = []
    const off = subscribeDataChange((p) => got.push(p))
    off()

    broadcastDataChange('model')

    expect(got).toHaveLength(0)
  })
})

describe('合并节流', () => {
  it('窗口内连续变更：首条立即发，其余合并成一条补发', async () => {
    vi.useFakeTimers()
    const { subscribeDataChange, broadcastDataChange } = await fresh()
    const got: DataChangedPush[] = []
    subscribeDataChange((p) => got.push(p))

    broadcastDataChange('conversation')
    broadcastDataChange('conversation')
    broadcastDataChange('conversation')
    expect(got).toHaveLength(1) // 只有首条立即发出

    vi.advanceTimersByTime(150)
    expect(got).toHaveLength(2) // 窗口末尾补发一条，把后两次带走

    vi.advanceTimersByTime(500)
    expect(got).toHaveLength(2) // 之后不再有幽灵补发
  })

  it('窗口外的下一次变更照常立即发', async () => {
    vi.useFakeTimers()
    const { subscribeDataChange, broadcastDataChange } = await fresh()
    const got: DataChangedPush[] = []
    subscribeDataChange((p) => got.push(p))

    broadcastDataChange('error')
    vi.advanceTimersByTime(150) // 越过合并窗口
    broadcastDataChange('error')

    expect(got).toHaveLength(2)
  })
})

describe('降级：没有 BroadcastChannel', () => {
  it('改走 chrome.runtime.sendMessage，载荷不变', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const sendMessage = vi.fn(() => Promise.resolve())
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
    })
    const { broadcastDataChange } = await fresh()

    broadcastDataChange('model')

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'data:changed', domain: 'model' }),
    )
  })

  it('降级模式下订阅改挂 runtime.onMessage，退订能摘掉', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const registered: Array<(raw: unknown) => void> = []
    const removed: Array<(raw: unknown) => void> = []
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(() => Promise.resolve()),
        onMessage: {
          addListener: (fn: (raw: unknown) => void) => registered.push(fn),
          removeListener: (fn: (raw: unknown) => void) => removed.push(fn),
        },
      },
    })
    const { subscribeDataChange } = await fresh()
    const got: DataChangedPush[] = []
    const off = subscribeDataChange((p) => got.push(p))

    expect(registered).toHaveLength(1)
    // 模拟一条广播到达
    registered[0]({ kind: 'data:changed', domain: 'error', at: 1 })
    expect(got).toHaveLength(1)

    off()
    expect(removed[0]).toBe(registered[0])
  })

  it('sendMessage 无人接收产生 lastError 时静默吞掉', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const sendMessage = vi.fn(() => Promise.reject(new Error('no receiving end')))
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
    })
    const { broadcastDataChange } = await fresh()

    expect(() => broadcastDataChange('script')).not.toThrow()
  })
})
