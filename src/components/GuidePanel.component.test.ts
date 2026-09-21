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
/** 卡片内定位：页面现在有「运行用户脚本」「读取本地文件」两张卡，各自都有「打开扩展管理页」
 *  按钮，断言必须收窄到卡内，否则一张卡的状态会污染另一张的断言。 */
const inCard = (w: VueWrapper, card: string, testid: string) =>
  w.find(`[data-testid="${card}"] [data-testid="${testid}"]`)

/** 单张卡片的文本（页面级 text() 已不适合断言「这张卡有没有给步骤」） */
const cardText = (w: VueWrapper, card: string): string =>
  w.find(`[data-testid="${card}"]`).text()

/** 带「允许访问文件网址」探测结果的 chrome 壳（null = 不提供 extension，模拟探测不到） */
function stubChrome(fileAccess: boolean | null): void {
  vi.stubGlobal('chrome', {
    runtime: { id: 'EXTID' },
    tabs: { create },
    ...(fileAccess === null ? {} : { extension: { isAllowedFileSchemeAccess: () => fileAccess } }),
  })
}

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
    expect(inCard(w, 'guide-userscripts', 'guide-open-extension-page').exists()).toBe(true)
  })

  it('引擎已开启：不给步骤也不给直达（读一屏用不上的说明没意义）', async () => {
    const w = await mountPanel({ ...base, available: true })
    expect(text(w)).toContain('已开启')
    expect(cardText(w, 'guide-userscripts')).not.toContain('允许运行用户脚本')
    expect(inCard(w, 'guide-userscripts', 'guide-open-extension-page').exists()).toBe(false)
  })

  it('Firefox：不给直达按钮（about:addons 是特权 URL，tabs.create 打不开），改给手动路径', async () => {
    const w = await mountPanel({ ...base, isFirefox: true, chromeMajor: 0 })
    expect(text(w)).toContain('about:addons')
    expect(inCard(w, 'guide-userscripts', 'guide-open-extension-page').exists()).toBe(false)
    // 文件访问那张卡整块不渲染：Firefox 的开启口径没验证过，不预写步骤
    expect(w.find('[data-testid="guide-file-access"]').exists()).toBe(false)
  })

  it('检测失败：如实报错且不渲染状态卡片——绝不把「查不到」当成「没问题」', async () => {
    const w = await mountPanel(new Error('扩展服务未响应，请重试'))
    expect(text(w)).toContain('状态检测失败')
    expect(text(w)).toContain('扩展服务未响应，请重试')
    expect(w.find('[data-testid="guide-userscripts"]').exists()).toBe(false)
    expect(w.find('[data-testid="guide-file-access"]').exists()).toBe(false)
  })
})

describe('GuidePanel 读取本地文件（允许访问文件网址）', () => {
  it('未开启：标「未开启」、给步骤、给自己的直达入口', async () => {
    stubChrome(false)
    const w = await mountPanel(base)
    expect(text(w)).toContain('读取本地文件')
    expect(w.find('[data-testid="guide-file-access-status"]').text()).toBe('未开启')
    // 步骤里点名要开的那道开关
    expect(text(w)).toContain('允许访问文件网址')
    expect(inCard(w, 'guide-file-access', 'guide-file-access-open-extension-page').exists()).toBe(true)
  })

  it('已开启：标「已开启」，不再给步骤与直达', async () => {
    stubChrome(true)
    const w = await mountPanel(base)
    expect(w.find('[data-testid="guide-file-access-status"]').text()).toBe('已开启')
    // 「允许访问文件网址」只出现在步骤里，步骤没了这句话就没了
    expect(text(w)).not.toContain('允许访问文件网址')
    expect(inCard(w, 'guide-file-access', 'guide-file-access-open-extension-page').exists()).toBe(false)
  })

  it('探测不到（各版本 API 缺失）：标「未能检测」并照给步骤，不硬说「未开启」', async () => {
    stubChrome(null)
    const w = await mountPanel(base)
    expect(w.find('[data-testid="guide-file-access-status"]').text()).toBe('未能检测')
    expect(inCard(w, 'guide-file-access', 'guide-file-access-open-extension-page').exists()).toBe(true)
  })
})

describe('GuidePanel 交互', () => {
  it('点「打开扩展管理页」：按 availability.chromeMajor 拼 URL 交给 chrome.tabs.create', async () => {
    stubChrome(true)
    const w = await mountPanel(base)
    await inCard(w, 'guide-userscripts', 'guide-open-extension-page').trigger('click')
    await flushPromises()
    expect(create).toHaveBeenCalledWith({ url: 'chrome://extensions/?id=EXTID' })
  })

  it('低版本 Chrome：直达退到扩展列表页（要开的是整页右上角的全局「开发者模式」）', async () => {
    stubChrome(true)
    const w = await mountPanel({ ...base, chromeMajor: 120 })
    await inCard(w, 'guide-userscripts', 'guide-open-extension-page').trigger('click')
    await flushPromises()
    expect(create).toHaveBeenCalledWith({ url: 'chrome://extensions/' })
  })

  it('「重新检测」：可用性与文件访问开关**都**重查（两个开关都可能刚被用户改过）', async () => {
    stubChrome(false)
    const w = await mountPanel(base)
    expect(availability).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="guide-file-access-status"]').text()).toBe('未开启')

    // 用户去扩展详情页开了开关 → 重新检测应把状态刷新成已开启
    stubChrome(true)
    availability.mockResolvedValueOnce({ ...base, available: true })
    await button(w, 'guide-redetect').trigger('click')
    await flushPromises()

    expect(availability).toHaveBeenCalledTimes(2)
    expect(text(w)).toContain('已开启')
    expect(w.find('[data-testid="guide-file-access-status"]').text()).toBe('已开启')
  })

  it('订阅广播：SW 推送 availabilityChanged 时状态直接更新（无需手动重查）', async () => {
    const w = await mountPanel(base)
    expect(text(w)).toContain('未开启')

    const cb = subscribeAvailability.mock.calls.at(-1)![0] as (a: UserScriptsAvailability) => void
    cb({ ...base, available: true })
    await flushPromises()
    expect(text(w)).toContain('已开启')
    expect(cardText(w, 'guide-userscripts')).not.toContain('允许运行用户脚本')
  })

  it('卸载时退订广播', async () => {
    const w = await mountPanel(base)
    const unsub = subscribeAvailability.mock.results.at(-1)!.value as ReturnType<typeof vi.fn>
    w.unmount()
    expect(unsub).toHaveBeenCalled()
  })
})
