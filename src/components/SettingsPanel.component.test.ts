// UI 组件测试：SettingsPanel.vue（设置外壳 —— 左栏分区导航 + 右栏内容）。
//
// 只验证「注册表 → 界面」的映射与切换，不测样式；这正是「新增设置菜单只需改
// settings/sections.ts」这一扩展契约的守卫：注册表加一项，左栏就应多一个导航项。
// 边界 mock：模型分区走 window.api（IPC）与数据广播，二者都置空以保持用例自包含。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import SettingsPanel from './SettingsPanel.vue'
import { SETTINGS_SECTIONS } from './settings/sections'

// 分区内容会订阅数据变更广播：置空，避免依赖 BroadcastChannel / chrome 消息通道
vi.mock('@/lib/data-broadcast', () => ({
  subscribeDataChange: () => () => {},
  broadcastDataChange: () => {},
  broadcastBuildPhase: () => {},
}))

const modelList = vi.hoisted(() => vi.fn(async () => ({ profiles: [], activeId: '' })))
const providerList = vi.hoisted(() => vi.fn(async () => []))

let wrapper: VueWrapper | null = null

beforeEach(() => {
  // 版本号与分支都来自构建期 define 注入的 __BUILD_INFO__（页面侧），
  // manifest 仅作版本号兜底。两者刻意给不同值：证明版本号确实取自注入值、
  // 没有退化成 manifest（manifest 会裁掉 -alpha.N 预发布标签）。
  vi.stubGlobal('chrome', {
    runtime: {
      getManifest: () => ({ version: '0.1.0' }),
      // 关于分区挂载时会经 sw:buildInfo 取 SW 构建信息：直接给成功应答，
      // 免得走 3 × 800ms 的重试等待（否则每条用例要白等 2.4s）
      lastError: undefined,
      sendMessage: (_msg: unknown, cb: (r: unknown) => void) =>
        cb({ ok: true, data: { time: '2026-01-01T00:00:00.000Z', branch: 'test-branch' } }),
    },
  })
  vi.stubGlobal('__BUILD_INFO__', {
    time: '2026-01-01T00:00:00.000Z',
    branch: 'test-branch',
    version: '9.9.9-alpha.2',
  })
  vi.stubGlobal('api', {
    model: { list: modelList, toggle: vi.fn(), delete: vi.fn() },
    provider: { list: providerList },
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function mountPanel(): Promise<VueWrapper> {
  wrapper = mount(SettingsPanel)
  await flushPromises()
  return wrapper
}

/** 左栏导航项（纵向 Tabs 的触发按钮，role=tab） */
const navButtons = (w: VueWrapper) => w.findAll('[role="tab"]')

describe('SettingsPanel 分区导航', () => {
  it('注册表里每个分区都出现在左栏（顺序一致）', async () => {
    const w = await mountPanel()
    expect(navButtons(w).map((b) => b.text())).toEqual(SETTINGS_SECTIONS.map((s) => s.label))
  })

  it('默认选中首个分区，右栏渲染其内容', async () => {
    const w = await mountPanel()
    expect(navButtons(w)[0].attributes('data-state')).toBe('active')
    // 首个分区（模型管理）正文已渲染
    expect(w.text()).toContain('配置 API key')
    // 未选中的「关于」不渲染（分区按需挂载）
    expect(w.text()).not.toContain('当前安装的扩展版本')
  })

  it('点左栏「关于」：右栏切到关于分区，版本号取注入的完整版本（含预发布标签）', async () => {
    const w = await mountPanel()
    const about = navButtons(w).find((b) => b.text().includes('关于'))
    expect(about).toBeTruthy()
    // reka-ui 的 TabsTrigger 在 mousedown（左键）上激活，click 不生效（实测）
    await about!.trigger('mousedown')
    await flushPromises()

    // 完整版本号（含 -alpha.2）——若退化成 manifest 就会只剩 v0.1.0，此断言即失败
    expect(w.text()).toContain('v9.9.9-alpha.2')
    expect(w.text()).not.toContain('v0.1.0')
    expect(w.text()).toContain('test-branch')
    // 构建信息从工作台顶栏移入此处：页面 / SW 两行都在，且 SW 拿到了应答（非「未响应」）
    expect(w.text()).toContain('页面')
    expect(w.text()).toContain('Service Worker')
    expect(w.text()).not.toContain('未响应')
    expect(w.text()).not.toContain('配置 API key')
  })
})
