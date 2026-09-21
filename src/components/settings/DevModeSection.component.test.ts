// 组件测试：设置 · 开发者分区（DevModeSection.vue）—— 总开关 + 每个入口各自的开关。
//
// 守四条：初值从存储读、总闸关时各页开关禁用、点开关写回存储、外部改动经订阅回填。
// 边界 mock：只把三个读写函数与订阅替掉，DEV_PAGES 用真实清单（顺序即渲染顺序）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import DevModeSection from './DevModeSection.vue'
import { DEV_PAGES } from '@/lib/dev-mode-store'

const getDevModeState = vi.hoisted(() => vi.fn())
const setDevMode = vi.hoisted(() => vi.fn(async () => {}))
const setDevPageEnabled = vi.hoisted(() => vi.fn(async () => {}))
const subscribeDevMode = vi.hoisted(() => vi.fn())

let push: ((s: { enabled: boolean; disabled: string[] }) => void) | undefined
subscribeDevMode.mockImplementation((cb: (s: { enabled: boolean; disabled: string[] }) => void) => {
  push = cb
  return () => {
    push = undefined
  }
})

vi.mock('@/lib/dev-mode-store', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/dev-mode-store')>('@/lib/dev-mode-store')
  return {
    DEV_PAGES: actual.DEV_PAGES,
    getDevModeState,
    setDevMode,
    setDevPageEnabled,
    subscribeDevMode,
  }
})

const wrappers: VueWrapper[] = []

async function mountSection(state: { enabled: boolean; disabled: string[] }): Promise<VueWrapper> {
  getDevModeState.mockResolvedValue(state)
  const w = mount(DevModeSection)
  wrappers.push(w)
  await flushPromises()
  return w
}

/** 全部开关：第 0 个是总闸，之后按 DEV_PAGES 顺序 */
const switches = (w: VueWrapper) => w.findAll('[role="switch"]')
const master = (w: VueWrapper) => switches(w)[0]!
const page = (w: VueWrapper, i: number) => switches(w)[i + 1]!

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers.length = 0
  push = undefined
  vi.clearAllMocks()
})

describe('设置 · 开发者分区', () => {
  it('总闸 + 每个入口各一个开关', async () => {
    const w = await mountSection({ enabled: false, disabled: [] })
    expect(switches(w)).toHaveLength(1 + DEV_PAGES.length)
    for (const p of DEV_PAGES) expect(w.text()).toContain(p.label)
  })

  it('总闸关着：各页开关禁用且都是关态', async () => {
    const w = await mountSection({ enabled: false, disabled: [] })
    expect(master(w).attributes('data-state')).toBe('unchecked')
    for (let i = 0; i < DEV_PAGES.length; i++) {
      expect(page(w, i).attributes('disabled')).toBeDefined()
      expect(page(w, i).attributes('data-state')).toBe('unchecked')
    }
  })

  it('总闸打开：各页开关可用、默认全开；被单独关掉的页除外', async () => {
    const w = await mountSection({ enabled: true, disabled: ['gm-api'] })
    expect(master(w).attributes('data-state')).toBe('checked')

    const offIndex = DEV_PAGES.findIndex((p) => p.id === 'gm-api')
    for (let i = 0; i < DEV_PAGES.length; i++) {
      expect(page(w, i).attributes('disabled')).toBeUndefined()
      const expected = i === offIndex ? 'unchecked' : 'checked'
      expect(page(w, i).attributes('data-state')).toBe(expected)
    }
  })

  it('点总闸：写回总开关', async () => {
    const w = await mountSection({ enabled: false, disabled: [] })
    await master(w).trigger('click')
    await flushPromises()
    expect(setDevMode).toHaveBeenCalledWith(true)
  })

  it('点某一页：只改那一页（关掉 → setDevPageEnabled(id, false)）', async () => {
    const w = await mountSection({ enabled: true, disabled: [] })
    const offIndex = DEV_PAGES.findIndex((p) => p.id === 'chat-data')

    await page(w, offIndex).trigger('click')
    await flushPromises()

    expect(setDevPageEnabled).toHaveBeenCalledWith('chat-data', false)
    expect(setDevMode).not.toHaveBeenCalled()
    expect(page(w, offIndex).attributes('data-state')).toBe('unchecked')
  })

  it('外部改动经订阅回填', async () => {
    const w = await mountSection({ enabled: false, disabled: [] })
    expect(master(w).attributes('data-state')).toBe('unchecked')

    push?.({ enabled: true, disabled: ['agent-tools'] })
    await flushPromises()

    expect(master(w).attributes('data-state')).toBe('checked')
    const offIndex = DEV_PAGES.findIndex((p) => p.id === 'agent-tools')
    expect(page(w, offIndex).attributes('data-state')).toBe('unchecked')
    // 外部改动不该反过来再写一次存储
    expect(setDevMode).not.toHaveBeenCalled()
    expect(setDevPageEnabled).not.toHaveBeenCalled()
  })

  it('卸载时退订', async () => {
    const w = await mountSection({ enabled: false, disabled: [] })
    expect(subscribeDevMode).toHaveBeenCalledTimes(1)
    w.unmount()
    expect(push).toBeUndefined()
  })
})
