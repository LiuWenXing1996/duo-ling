// 组件测试：设置 · 开发者分区的开关（DevModeSection.vue）。
//
// 守三条：初值从存储读、切换写回存储并反映到界面、外部改动经订阅回到界面。
// 边界 mock：存储模块整体替掉（本组件的职责只是把开关接到那三个函数上）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import DevModeSection from './DevModeSection.vue'

const getDevMode = vi.hoisted(() => vi.fn(async () => false))
const setDevMode = vi.hoisted(() => vi.fn(async () => {}))
const subscribeDevMode = vi.hoisted(() => vi.fn())

let push: ((v: boolean) => void) | undefined
subscribeDevMode.mockImplementation((cb: (v: boolean) => void) => {
  push = cb
  return () => {
    push = undefined
  }
})

vi.mock('@/lib/dev-mode-store', () => ({ getDevMode, setDevMode, subscribeDevMode }))

const wrappers: VueWrapper[] = []

async function mountSection(): Promise<VueWrapper> {
  const w = mount(DevModeSection)
  wrappers.push(w)
  await flushPromises()
  return w
}

/** 开关本体（reka-ui SwitchRoot → role=switch 的 button） */
const toggle = (w: VueWrapper) => w.find('[role="switch"]')

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers.length = 0
  push = undefined
  vi.clearAllMocks()
})

describe('设置 · 开发者分区的开关', () => {
  it('初值取自存储：关闭态', async () => {
    getDevMode.mockResolvedValue(false)
    const w = await mountSection()
    expect(getDevMode).toHaveBeenCalledTimes(1)
    expect(toggle(w).attributes('data-state')).toBe('unchecked')
  })

  it('初值取自存储：开启态', async () => {
    getDevMode.mockResolvedValue(true)
    const w = await mountSection()
    expect(toggle(w).attributes('data-state')).toBe('checked')
  })

  it('点开关：写回存储，界面跟着切到开启', async () => {
    getDevMode.mockResolvedValue(false)
    const w = await mountSection()

    await toggle(w).trigger('click')
    await flushPromises()

    expect(setDevMode).toHaveBeenCalledWith(true)
    expect(toggle(w).attributes('data-state')).toBe('checked')
  })

  it('外部改动经订阅回到界面', async () => {
    getDevMode.mockResolvedValue(false)
    const w = await mountSection()
    expect(toggle(w).attributes('data-state')).toBe('unchecked')

    push?.(true)
    await flushPromises()

    expect(toggle(w).attributes('data-state')).toBe('checked')
    // 外部改动不该反过来再写一次存储
    expect(setDevMode).not.toHaveBeenCalled()
  })

  it('卸载时退订', async () => {
    getDevMode.mockResolvedValue(false)
    const w = await mountSection()
    expect(subscribeDevMode).toHaveBeenCalledTimes(1)

    w.unmount()
    expect(push).toBeUndefined()
  })
})
