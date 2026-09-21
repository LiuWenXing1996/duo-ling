// dev-mode-store 单测：默认关闭、读写往返、订阅只对 local 区的目标键回调。
//
// 边界 mock：chrome.storage 在 node 环境不存在，用一份内存实现替掉
// （包括 onChanged 的监听器表，以便直接触发变更）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDevMode, setDevMode, subscribeDevMode } from './dev-mode-store'

const KEY = 'duoling:devMode'

type Change = { newValue?: unknown }
type Listener = (changes: Record<string, Change>, area: string) => void

let store: Record<string, unknown>
let listeners: Listener[]

beforeEach(() => {
  store = {}
  listeners = []
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
        set: async (items: Record<string, unknown>) => {
          const changes: Record<string, Change> = {}
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { newValue: v }
            store[k] = v
          }
          for (const l of listeners) l(changes, 'local')
        },
      },
      onChanged: {
        addListener: (l: Listener) => listeners.push(l),
        removeListener: (l: Listener) => {
          listeners = listeners.filter((x) => x !== l)
        },
      },
    },
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('开发者模式存储', () => {
  it('键不存在时视为关闭', async () => {
    expect(await getDevMode()).toBe(false)
  })

  it('写入后可读回', async () => {
    await setDevMode(true)
    expect(store[KEY]).toBe(true)
    expect(await getDevMode()).toBe(true)
  })

  it('订阅者收到变化；退订后不再收到', async () => {
    const seen: boolean[] = []
    const off = subscribeDevMode((v) => seen.push(v))
    await setDevMode(true)
    await setDevMode(false)
    expect(seen).toEqual([true, false])

    off()
    await setDevMode(true)
    expect(seen).toEqual([true, false])
  })

  it('别的键、以及非 local 区的变化都不回调', async () => {
    const seen: boolean[] = []
    subscribeDevMode((v) => seen.push(v))
    for (const l of listeners) l({ other: { newValue: true } }, 'local')
    for (const l of listeners) l({ [KEY]: { newValue: true } }, 'sync')
    expect(seen).toEqual([])
  })
})
