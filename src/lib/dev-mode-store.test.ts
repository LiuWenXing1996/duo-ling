// dev-mode-store 单测：总开关与单页开关的读写、非 local 区不回调、非法 id 过滤。
//
// 边界 mock：chrome.storage 在 node 环境不存在，用一份内存实现替掉
// （包括 onChanged 的监听器表，以便直接触发变更）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getDevModeState,
  setDevMode,
  setDevPageEnabled,
  subscribeDevMode,
} from './dev-mode-store'

const MODE_KEY = 'duoling:devMode'
const DISABLED_KEY = 'duoling:devPagesOff'

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

/** 等 storage.onChanged → getDevModeState().then(cb) 这条异步链跑完 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

afterEach(() => vi.unstubAllGlobals())

describe('开发者模式存储', () => {
  it('默认：总闸关、没有被单独关掉的页', async () => {
    expect(await getDevModeState()).toEqual({ enabled: false, disabled: [] })
  })

  it('总闸开关可写可读', async () => {
    await setDevMode(true)
    expect(store[MODE_KEY]).toBe(true)
    expect((await getDevModeState()).enabled).toBe(true)
  })

  it('单页开关：关掉后进 disabled，打开后再移出', async () => {
    await setDevPageEnabled('gm-api', false)
    expect(await getDevModeState()).toEqual({ enabled: false, disabled: ['gm-api'] })

    await setDevPageEnabled('agent-tools', false)
    expect((await getDevModeState()).disabled).toEqual(['gm-api', 'agent-tools'])

    await setDevPageEnabled('gm-api', true)
    expect((await getDevModeState()).disabled).toEqual(['agent-tools'])
  })

  it('同一页重复开关不产生重复项', async () => {
    await setDevPageEnabled('chat-data', false)
    await setDevPageEnabled('chat-data', false)
    expect((await getDevModeState()).disabled).toEqual(['chat-data'])
  })

  it('存储里混入非法 id 时被过滤掉（不影响既有页判断）', async () => {
    store[DISABLED_KEY] = ['chat-data', 'not-a-page', 42]
    expect((await getDevModeState()).disabled).toEqual(['chat-data'])
  })

  it('订阅：总闸与单页变化都回调，退订后不再收到', async () => {
    const seen: string[] = []
    const off = subscribeDevMode((s) =>
      seen.push(`${s.enabled ? 'on' : 'off'}:${s.disabled.join(',')}`),
    )

    await setDevMode(true)
    await settle()
    await setDevPageEnabled('gm-api', false)
    await settle()
    expect(seen).toEqual(['on:', 'on:gm-api'])

    off()
    await setDevMode(false)
    await settle()
    expect(seen).toHaveLength(2)
  })

  it('别的键、以及非 local 区的变化都不回调', async () => {
    const seen: unknown[] = []
    subscribeDevMode((s) => seen.push(s))

    for (const l of listeners) l({ other: { newValue: true } }, 'local')
    for (const l of listeners) l({ [MODE_KEY]: { newValue: true } }, 'sync')
    expect(seen).toEqual([])
  })
})
