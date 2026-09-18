// UI 组件测试：GuidePanel.vue（引导标签页的状态分支渲染）。
// 只验证四种状态各自的渲染与入口显隐，不测样式：
// 检测失败（不假装可用）/ 引擎未开启（给步骤 + 直达）/ 引擎已开启（不给步骤）/ Firefox（不给直达）。
// 边界 mock：用户脚本客户端（IPC）。扩展页跳转走真实 openOwnExtensionPage，只 stub chrome.tabs.create。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import GuidePanel from './GuidePanel.vue'
import type { UserScriptsAvailability } from '@/lib/userscripts/types'

const availability = vi.hoisted(() => vi.fn())
const subscribeAvailability = vi.hoisted(() =>
  vi.fn((cb: (a: UserScriptsAvailability) => void) => vi.fn()),
)
vi.mock('@/lib/userscripts/ui-client', () => ({
  userscriptClient: { availability },
  subscribeAvailability,
}))

const create = vi.hoisted(() => vi.fn(async () => undefined))

const base: UserScriptsAvailability = {
  available: false,
  isFirefox: false,
  chromeMajor: 142,
  guideText: '（引导页不复用这句话，仅类型占位）',
}

/** 跨用例追踪已挂载实例：GuidePanel 会订阅可用性广播，用例结束不 unmount 的话
 * mock 调用记录会跨用例串味（calls.at(-1) 取到的是历史用例的订阅） */
const wrappers: VueWrapper[] = []

async function mountPanel(av: UserScriptsAvailability | Error): Promise<VueWrapper> {
  if (av instanceof Error) availability.mockRejectedValueOnce(av)
  else availability.mockResolvedValueOnce(av)
  const w = mount(GuidePanel)
  wrappers.push(w)
  await flushPromises()
  return w
}

const text = (w: VueWrapper): string => w.text()
const button = (w: VueWrapper, testid: string) => w.find(`[data-testid="${testid}"]`)

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers.length = 0
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('GuidePanel 状态分支', () => {
  it('引擎未开启：给状态、给步骤、给「打开扩展管理页」入口', async () => {
    const w = await mountPanel(base)
    expect(text(w)).toContain('未开启')
    expect(text(w)).toContain('允许运行用户脚本')
    expect(button(w, 'guide-open-extension-page').exists()).toBe(true)
  })

  it('引擎已开启：不给步骤也不给直达（读一屏用不上的说明没意义）', async () => {
    const w = await mountPanel({ ...base, available: true })
    expect(text(w)).toContain('已开启')
    expect(text(w)).not.toContain('允许运行用户脚本')
    expect(button(w, 'guide-open-extension-page').exists()).toBe(false)
  })

  it('Firefox：不给直达按钮（about:addons 是特权 URL，tabs.create 打不开），改给手动路径', async () => {
    const w = await mountPanel({ ...base, isFirefox: true, chromeMajor: 0 })
    expect(text(w)).toContain('about:addons')
    expect(button(w, 'guide-open-extension-page').exists()).toBe(false)
  })

  it('检测失败：如实报错且不渲染状态卡片——绝不把「查不到」当成「没问题」', async () => {
    const w = await mountPanel(new Error('background 无响应'))
    expect(text(w)).toContain('状态检测失败')
    expect(text(w)).toContain('background 无响应')
    expect(w.find('[data-testid="guide-userscripts"]').exists()).toBe(false)
  })
})

describe('GuidePanel 交互', () => {
  it('点「打开扩展管理页」：按 availability.chromeMajor 拼 URL 交给 chrome.tabs.create', async () => {
    vi.stubGlobal('chrome', { runtime: { id: 'EXTID' }, tabs: { create } })
    const w = await mountPanel(base)
    await button(w, 'guide-open-extension-page').trigger('click')
    await flushPromises()
    expect(create).toHaveBeenCalledWith({ url: 'chrome://extensions/?id=EXTID' })
  })

  it('低版本 Chrome：直达退到扩展列表页（要开的是整页右上角的全局「开发者模式」）', async () => {
    vi.stubGlobal('chrome', { runtime: { id: 'EXTID' }, tabs: { create } })
    const w = await mountPanel({ ...base, chromeMajor: 120 })
    await button(w, 'guide-open-extension-page').trigger('click')
    await flushPromises()
    expect(create).toHaveBeenCalledWith({ url: 'chrome://extensions/' })
  })

  it('「重新检测」：再查一次可用性（用户开完开关回来刷新状态）', async () => {
    const w = await mountPanel(base)
    expect(availability).toHaveBeenCalledTimes(1)
    availability.mockResolvedValueOnce({ ...base, available: true })
    await button(w, 'guide-redetect').trigger('click')
    await flushPromises()
    expect(availability).toHaveBeenCalledTimes(2)
    expect(text(w)).toContain('已开启')
  })

  it('订阅广播：SW 推送 availabilityChanged 时状态直接更新（无需手动重查）', async () => {
    const w = await mountPanel(base)
    expect(text(w)).toContain('未开启')

    const cb = subscribeAvailability.mock.calls.at(-1)![0] as (a: UserScriptsAvailability) => void
    cb({ ...base, available: true })
    await flushPromises()
    expect(text(w)).toContain('已开启')
    expect(text(w)).not.toContain('允许运行用户脚本')
  })

  it('卸载时退订广播', async () => {
    const w = await mountPanel(base)
    const unsub = subscribeAvailability.mock.results.at(-1)!.value as ReturnType<typeof vi.fn>
    w.unmount()
    expect(unsub).toHaveBeenCalled()
  })
})
