// 组件测试：设置 · 开发者分区（DevModeSection.vue）—— 调试面板入口 + 通知 / 角标两个自测工具。
//
// 守三条：清单里的面板各有一行入口、点某行把 kind 与标题交给宿主（emit openTab）、
// 分区里不再有「控制显示与否」的开关。
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import DevModeSection from './DevModeSection.vue'

/** 入口清单（顺序即渲染顺序）：kind → 面板名 */
const PANELS = [
  ['ui-test', 'AI 界面对话预览'],
  ['lfs-browser', '脚本文件'],
  ['chat-data', '会话数据'],
  ['net-log', '接口数据'],
  ['agent-tools', 'AI 工具'],
  ['gm-api', 'GM API'],
] as const

const wrappers: VueWrapper[] = []

function mountSection(): VueWrapper {
  const w = mount(DevModeSection)
  wrappers.push(w)
  return w
}

/** 某面板的入口行 */
const entry = (w: VueWrapper, kind: string) => w.find(`[data-testid="dev-open-${kind}"]`)

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers.length = 0
})

describe('设置 · 开发者分区', () => {
  it('每个调试面板各一行入口，文案即面板名', () => {
    const w = mountSection()
    for (const [kind, label] of PANELS) {
      const row = entry(w, kind)
      expect(row.exists()).toBe(true)
      expect(row.text()).toBe(label)
    }
    // 入口不多不少：多出来的行只会在设置页里变成噪音
    expect(w.findAll('[data-testid^="dev-open-"]')).toHaveLength(PANELS.length)
  })

  it('点某一行：把 kind 与标题一并交给宿主', async () => {
    const w = mountSection()
    await entry(w, 'gm-api').trigger('click')
    expect(w.emitted('openTab')).toEqual([['gm-api', 'GM API']])
  })

  it('分区里没有开关：入口只负责打开，不控制显示与否', () => {
    const w = mountSection()
    expect(w.findAll('[role="switch"]')).toHaveLength(0)
  })
})

// 角标调试栏：文字与配色都要真的落到工具栏角标上（chrome.action 由测试基建的 fakeBrowser 承接），
// 且清除要连输入框与两个取色器一起复位 —— 留着一段已经不在角标上的文字、或刚试出来的颜色，
// 都会让人以为角标还是那个样子。
describe('设置 · 开发者分区 · 角标调试栏', () => {
  const input = (w: VueWrapper) => w.find('[data-testid="dev-badge-input"]')
  const btn = (w: VueWrapper, testid: string) => w.find(`[data-testid="${testid}"]`)

  it('应用：输入的文字设到角标上，并显示当前字数', async () => {
    const w = mountSection()
    await input(w).setValue('9+')
    expect(w.text()).toContain('2 字符')

    await btn(w, 'dev-badge-apply').trigger('click')
    await flushPromises()

    expect(await chrome.action.getBadgeText({})).toBe('9+')
  })

  it('回车即应用（不必去点按钮）', async () => {
    const w = mountSection()
    await input(w).setValue('•')
    await input(w).trigger('keyup.enter')
    await flushPromises()

    expect(await chrome.action.getBadgeText({})).toBe('•')
  })

  it('清除：角标与输入框一起清空', async () => {
    const w = mountSection()
    await input(w).setValue('12')
    await btn(w, 'dev-badge-apply').trigger('click')
    await flushPromises()
    expect(await chrome.action.getBadgeText({})).toBe('12')

    await btn(w, 'dev-badge-clear').trigger('click')
    await flushPromises()

    expect(await chrome.action.getBadgeText({})).toBe('')
    expect((input(w).element as HTMLInputElement).value).toBe('')
  })

  // 颜色读回在 fakeBrowser 里是两套格式：底色给 RGBA 数组、字色给原始字符串。
  // 断言按它的实际行为写 —— 照 Chrome 文档那套 ColorArray 去写，两条必挂。
  it('应用：底色与字色一并落到角标上', async () => {
    const w = mountSection()
    await input(w).setValue('5')
    await btn(w, 'dev-badge-bg').setValue('#123456')
    await btn(w, 'dev-badge-fg').setValue('#abcdef')

    await btn(w, 'dev-badge-apply').trigger('click')
    await flushPromises()

    expect(await chrome.action.getBadgeBackgroundColor({})).toEqual([0x12, 0x34, 0x56, 255])
    expect(await chrome.action.getBadgeTextColor({})).toBe('#abcdef')
  })

  it('清除：两个取色器一并复位，免得角标挂着刚试出来的颜色', async () => {
    const w = mountSection()
    await input(w).setValue('3')
    await btn(w, 'dev-badge-bg').setValue('#000000')
    await btn(w, 'dev-badge-fg').setValue('#000000')
    await btn(w, 'dev-badge-apply').trigger('click')
    await flushPromises()

    await btn(w, 'dev-badge-clear').trigger('click')
    await flushPromises()

    expect((btn(w, 'dev-badge-bg').element as HTMLInputElement).value).toBe('#1a73e8')
    expect((btn(w, 'dev-badge-fg').element as HTMLInputElement).value).toBe('#ffffff')
  })
})
