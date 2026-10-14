// 组件测试：设置 · 开发者分区（DevModeSection.vue）—— 调试面板入口 + 通知 / 角标两个自测工具。
//
// 守三条：清单里的面板各有一行入口、点某行把 kind 与标题交给宿主（emit openTab，
// 「会话数据」特例发 openSessionData——它没有独立标签页）、分区里不再有「控制显示与否」的开关。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import DevModeSection from './DevModeSection.vue'

/** 入口清单（顺序即渲染顺序）：kind → 面板名；session-data 是特例行（发 openSessionData） */
const PANELS = [
  ['lfs-browser', '文件管理'],
  ['session-data', '会话数据'],
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

  it('「会话数据」是特例：发 openSessionData 而不是 openTab（它没有独立标签页）', async () => {
    const w = mountSection()
    await entry(w, 'session-data').trigger('click')
    expect(w.emitted('openSessionData')).toHaveLength(1)
    expect(w.emitted('openTab')).toBeUndefined()
  })

  it('分区里没有开关：入口只负责打开，不控制显示与否', () => {
    const w = mountSection()
    expect(w.findAll('[role="switch"]')).toHaveLength(0)
  })
})

// 通知调试栏：`create` 被拒绝时（图标取不到等）原因必须留在面板上 —— 只进 console 的话，这个
// 「确认通知能不能显示」的工具自己就成了「点了没反应」，看不出是发失败还是没发出去。
// 另一路是 `create` 成功但系统不放行（denied），它没有报错可显示，故单独走权限判据。
describe('设置 · 开发者分区 · 通知调试栏', () => {
  const send = (w: VueWrapper) => w.find('[data-testid="dev-notify-send"]')
  const errorLine = (w: VueWrapper) => w.find('[data-testid="dev-notify-error"]')
  const deniedLine = (w: VueWrapper) => w.find('[data-testid="dev-notify-denied"]')

  /**
   * 把权限判据喂成给定值。`as never`：spyOn 落在 `getPermissionLevel(callback)` 那个重载上、
   * 返回值类型成了 void，而真实实现返回的是 Promise。
   */
  function stubPermissionLevel(level: 'granted' | 'denied'): void {
    vi.spyOn(chrome.notifications, 'getPermissionLevel').mockResolvedValue(level as never)
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('发送成功：通知真的交给 chrome.notifications，面板不留提示行', async () => {
    const create = vi.spyOn(chrome.notifications, 'create')
    stubPermissionLevel('granted')
    const w = mountSection()

    await send(w).trigger('click')
    await flushPromises()

    expect(create).toHaveBeenCalledTimes(1)
    expect(errorLine(w).exists()).toBe(false)
    expect(deniedLine(w).exists()).toBe(false)
  })

  it('发送失败：原因就地显示', async () => {
    vi.spyOn(chrome.notifications, 'create').mockRejectedValueOnce(
      new Error('Unable to download all specified images.'),
    )
    const w = mountSection()

    await send(w).trigger('click')
    await flushPromises()

    expect(errorLine(w).text()).toBe('Unable to download all specified images.')
  })

  it('发成功但系统不放行：提示这条通知不会显示（create 抓不到这一路）', async () => {
    stubPermissionLevel('denied')
    const w = mountSection()

    await send(w).trigger('click')
    await flushPromises()

    expect(deniedLine(w).exists()).toBe(true)
    expect(errorLine(w).exists()).toBe(false)
  })

  it('权限判据取不到：仍按已发送处理，不多出提示行', async () => {
    // 判据是附加诊断 —— 它自己挂掉不能变成一个「发送失败」
    vi.spyOn(chrome.notifications, 'getPermissionLevel').mockImplementation(() => {
      throw new Error('not implemented')
    })
    const w = mountSection()

    await send(w).trigger('click')
    await flushPromises()

    expect(errorLine(w).exists()).toBe(false)
    expect(deniedLine(w).exists()).toBe(false)
  })

  it('失败之后恢复可用：再发一次成功，错误行随之消失', async () => {
    const create = vi.spyOn(chrome.notifications, 'create')
    stubPermissionLevel('granted')
    create.mockRejectedValueOnce(new Error('boom'))
    const w = mountSection()

    await send(w).trigger('click')
    await flushPromises()
    expect(errorLine(w).exists()).toBe(true)

    await send(w).trigger('click')
    await flushPromises()
    expect(errorLine(w).exists()).toBe(false)
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
