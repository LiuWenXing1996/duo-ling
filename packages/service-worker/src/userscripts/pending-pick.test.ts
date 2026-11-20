import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElementPickContext } from '@duoling/shared'
import {
  clearFlight,
  dropPickState,
  findFlightTab,
  PICK_TIMEOUT_MESSAGE,
  readPickState,
  recordFlight,
  settlePick,
} from './pending-pick'

function stubSession(): Map<string, unknown> {
  const bag = new Map<string, unknown>()
  const area = {
    get: async (keys: string | string[] | null) => {
      if (keys == null) return Object.fromEntries(bag)
      const list = Array.isArray(keys) ? keys : [keys]
      const out: Record<string, unknown> = {}
      for (const k of list) if (bag.has(k)) out[k] = bag.get(k)
      return out
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) bag.set(k, v)
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) bag.delete(k)
    },
  }
  vi.stubGlobal('chrome', { storage: { session: area } })
  return bag
}

const element = { summary: { tag: 'button' } } as unknown as ElementPickContext

beforeEach(() => {
  stubSession()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('readPickState', () => {
  it('没有任何记账：idle', async () => {
    expect(await readPickState(7)).toEqual({ status: 'idle' })
  })

  it('有进行中的下发且未超时：picking', async () => {
    await recordFlight(7, 'req-1', Date.now())
    expect(await readPickState(7)).toEqual({ status: 'picking' })
  })

  it('下发超过 60 秒还没结算：报超时并收掉记账（下一次读回到 idle）', async () => {
    vi.useFakeTimers()
    await recordFlight(7, 'req-1', Date.now())
    vi.setSystemTime(Date.now() + 61_000)
    expect(await readPickState(7)).toEqual({ status: 'error', message: PICK_TIMEOUT_MESSAGE })
    expect(await readPickState(7)).toEqual({ status: 'idle' })
  })

  it('已结算的结论：读过不删（popup 反复开关看到的是同一份）', async () => {
    await recordFlight(7, 'req-1', Date.now())
    await settlePick(7, 'req-1', { element })
    expect(await readPickState(7)).toEqual({ status: 'done', element })
    expect(await readPickState(7)).toEqual({ status: 'done', element })
  })

  it('失败的结论读到即消费（不该每次开窗都弹同一句错）', async () => {
    await recordFlight(7, 'req-1', Date.now())
    await settlePick(7, 'req-1', { message: '页面读取失败' })
    expect(await readPickState(7)).toEqual({ status: 'error', message: '页面读取失败' })
    expect(await readPickState(7)).toEqual({ status: 'idle' })
  })

  it('不同标签页互不干扰', async () => {
    await recordFlight(7, 'req-1', Date.now())
    await settlePick(7, 'req-1', { element })
    expect(await readPickState(8)).toEqual({ status: 'idle' })
    expect(await readPickState(7)).toEqual({ status: 'done', element })
  })

  it('新一轮下发覆盖上一份结论（不该看到旧 chip）', async () => {
    await recordFlight(7, 'req-1', Date.now())
    await settlePick(7, 'req-1', { element })
    await recordFlight(7, 'req-2', Date.now())
    expect(await readPickState(7)).toEqual({ status: 'picking' })
  })
})

describe('记账的认领与清理', () => {
  it('按 reqId 找回它属于哪一页；结算后找不到了', async () => {
    await recordFlight(7, 'req-1', Date.now())
    expect(await findFlightTab('req-1')).toBe(7)
    await settlePick(7, 'req-1', { element })
    expect(await findFlightTab('req-1')).toBeNull()
  })

  it('迟到 / 重复的 reqId 清不掉新一轮的记账', async () => {
    await recordFlight(7, 'req-1', Date.now())
    await recordFlight(7, 'req-2', Date.now())
    await clearFlight(7, 'req-1')
    expect(await readPickState(7)).toEqual({ status: 'picking' })
  })

  it('dropPickState 清掉结论与进行中记账（标签页关闭用）', async () => {
    await recordFlight(7, 'req-1', Date.now())
    await dropPickState(7)
    expect(await readPickState(7)).toEqual({ status: 'idle' })
    expect(await findFlightTab('req-1')).toBeNull()
  })
})

describe('没有 chrome.storage.session 时', () => {
  it('一律按 idle 处理，不抛错（降级不是崩溃）', async () => {
    vi.unstubAllGlobals()
    await expect(recordFlight(7, 'req-1', Date.now())).resolves.toBeUndefined()
    expect(await readPickState(7)).toEqual({ status: 'idle' })
    expect(await findFlightTab('req-1')).toBeNull()
    await expect(dropPickState(7)).resolves.toBeUndefined()
  })
})
