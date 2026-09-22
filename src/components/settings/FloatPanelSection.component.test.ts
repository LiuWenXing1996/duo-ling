// 组件测试：设置页「网页浮层」分区的开关、例外名单与添加区（FloatPanelSection.vue）。
//
// 守的是这块面的五件事：
//   A. 名单为空 → 给空态，规则说明是「所有网站都显示」；
//   B. 名单非空 → 逐行列出域名（按域名序；条目是 match pattern 时展示成裸域名），
//      点「恢复显示」按**条目原值**调 removeDisabledSite；
//   C. 总开关关着 → 规则说明改成「全站不显示」（例外名单暂不生效）；
//   D. 别处改了开关（订阅回调）→ 自动重拉；卸载时退订；
//   E. 添加区 → 拆输入后调 addDisabledSites，反馈分「新增 / 已在名单 / 未识别」，成功后清空输入。
//
// 按站点开关**不在这里**（设置页自己就是扩展页，查到的激活标签页永远是自己）—— 那部分归 popup，
// 其测试见 PopupPanel.component.test.ts。
//
// 边界 mock：float-panel-store 整块 mock，不牵进真实 storage；float-panel-host 走真实实现
// （那三个都是纯函数）；本分区不碰 chrome.tabs。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import FloatPanelSection from './FloatPanelSection.vue'

const getMasterEnabled = vi.hoisted(() => vi.fn())
const setMasterEnabled = vi.hoisted(() => vi.fn())
const getDisabledSites = vi.hoisted(() => vi.fn())
const removeDisabledSite = vi.hoisted(() => vi.fn())
const addDisabledSites = vi.hoisted(() => vi.fn())
const subscribeFloatSettings = vi.hoisted(() => vi.fn())

vi.mock('@/lib/float-panel-store', () => ({
  getMasterEnabled,
  setMasterEnabled,
  getDisabledSites,
  removeDisabledSite,
  addDisabledSites,
  subscribeFloatSettings,
}))

/** 订阅回调（store 的 mock 把它交出来，测试手动触发「别处改了开关」） */
let onSettingsChanged: (() => void) | null = null
const unsubscribe = vi.fn()

const wrappers: VueWrapper[] = []

async function mountSection(): Promise<VueWrapper> {
  const w = mount(FloatPanelSection)
  wrappers.push(w)
  await flushPromises()
  await flushPromises()
  return w
}

const rows = (w: VueWrapper) => w.findAll('[data-testid="float-site-row"]')
const rule = (w: VueWrapper) => w.find('[data-testid="float-rule"]')
const input = (w: VueWrapper) => w.find('[data-testid="float-add-input"]')
const feedback = (w: VueWrapper) => w.find('[data-testid="float-add-feedback"]')

beforeEach(() => {
  onSettingsChanged = null
  subscribeFloatSettings.mockImplementation((cb: () => void) => {
    onSettingsChanged = cb
    return unsubscribe
  })
  getMasterEnabled.mockResolvedValue(true)
  getDisabledSites.mockResolvedValue([])
  setMasterEnabled.mockResolvedValue(undefined)
  removeDisabledSite.mockResolvedValue(undefined)
  addDisabledSites.mockResolvedValue({ added: [], existing: [], invalid: [] })
})

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers.length = 0
  vi.clearAllMocks()
})

describe('设置页「网页浮层」的例外名单', () => {
  it('名单为空：给空态，规则说明是「所有网站都显示」', async () => {
    const w = await mountSection()

    expect(rows(w)).toHaveLength(0)
    expect(w.find('[data-testid="float-sites-empty"]').text()).toContain('尚未单独关闭任何网站')
    expect(rule(w).text()).toBe('浮层在所有网站显示。')
  })

  it('名单非空：条目展示成裸域名（按域名序），点「恢复显示」按原值删除', async () => {
    getDisabledSites.mockResolvedValue(['*://*.b.example/*', '*://*.a.example/*'])
    const w = await mountSection()

    expect(rows(w).map((r) => r.text())).toEqual([
      expect.stringContaining('a.example'),
      expect.stringContaining('b.example'),
    ])
    // 展示的是域名，不是 match pattern
    expect(rows(w)[0]!.text()).not.toContain('*://')
    expect(rule(w).text()).toBe('除下列网站外，所有网站都显示浮层。')

    await rows(w)[0]!.find('[data-testid="float-site-restore"]').trigger('click')
    await flushPromises()
    // 传的是存储里的原值 —— 按条目删，不做覆盖关系推断
    expect(removeDisabledSite).toHaveBeenCalledWith('*://*.a.example/*')
  })

  it('总开关关着：规则说明改成全站不显示（例外名单不生效）', async () => {
    getMasterEnabled.mockResolvedValue(false)
    getDisabledSites.mockResolvedValue(['*://*.a.example/*'])
    const w = await mountSection()

    expect(rule(w).text()).toBe('总开关已关闭：浮层在所有网站都不显示。')
    // 名单本身照旧列出——关掉总开关不等于清空用户的例外设置
    expect(rows(w)).toHaveLength(1)
  })

  it('别处改了开关：订阅回调触发重拉，清单跟着更新；卸载时退订', async () => {
    const w = await mountSection()
    expect(rows(w)).toHaveLength(0)

    // 模拟 popup / 内容脚本那边关掉了某站：存储变了，本页只是收到通知
    getDisabledSites.mockResolvedValue(['*://*.c.example/*'])
    onSettingsChanged?.()
    await flushPromises()

    expect(rows(w)).toHaveLength(1)
    expect(rows(w)[0]!.text()).toContain('c.example')

    w.unmount()
    wrappers.splice(wrappers.indexOf(w), 1)
    expect(unsubscribe).toHaveBeenCalled()
  })
})

describe('设置页「网页浮层」的添加区', () => {
  it('拆出多条输入 → 交给 addDisabledSites；反馈三分并清空输入', async () => {
    addDisabledSites.mockResolvedValue({
      added: ['*://*.example.com/*'],
      existing: ['*://*.www.a.com/*'],
      invalid: ['!bad!'],
    })
    const w = await mountSection()

    // 换行与空格都当分隔（粘贴一串域名的常态）
    await input(w).setValue('example.com\nhttps://www.a.com/x !bad!')
    await flushPromises()
    await w.find('[data-testid="float-add-submit"]').trigger('click')
    await flushPromises()

    expect(addDisabledSites).toHaveBeenCalledWith(['example.com', 'https://www.a.com/x', '!bad!'])
    expect(feedback(w).text()).toContain('已添加 1 个')
    expect(feedback(w).text()).toContain('1 个已在名单')
    expect(feedback(w).text()).toContain('未识别：!bad!')
    expect((input(w).element as HTMLTextAreaElement).value).toBe('')
  })

  it('一条都没进名单：反馈用错误色，且保留原文供就地修改', async () => {
    addDisabledSites.mockResolvedValue({ added: [], existing: [], invalid: ['nope'] })
    const w = await mountSection()

    await input(w).setValue('nope')
    await flushPromises()
    await w.find('[data-testid="float-add-submit"]').trigger('click')
    await flushPromises()

    expect(feedback(w).text()).toContain('未识别：nope')
    expect(feedback(w).classes()).toContain('text-destructive')
    expect((input(w).element as HTMLTextAreaElement).value).toBe('nope')
  })
})
