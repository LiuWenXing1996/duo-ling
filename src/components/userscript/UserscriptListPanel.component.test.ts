// UI 组件测试：UserscriptListPanel.vue 的「脚本列表不承载报错展示」行为。
//
// 2026-09-18 设计结论：报错属于历史信息，由独立「错误日志」标签页承载（左侧导航进入），
// 脚本列表本身不展示任何脚本报错 —— 环境级问题（引擎不可用）仅靠 availability 横幅统一兜底。
// 本测试覆盖四条易回归语义：
//   1. 列表挂载后不调用 userscriptClient.errors()（报错展示已迁出列表）
//   2. 有报错的脚本行也不显示行内入口（报错不按脚本逐条复述）
//   3. 启停返回 registerError 时列表不出现 per-script 报错提示（数据已保存，报错进独立标签页）
//   4. 引擎不可用时只显示 availability 横幅，不为每个脚本挂报错入口
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import UserscriptListPanel from './UserscriptListPanel.vue'
import type { ScriptSummary, UserScriptsAvailability } from '@/lib/userscripts/types'

const list = vi.hoisted(() => vi.fn())
const errors = vi.hoisted(() => vi.fn())
const availability = vi.hoisted(() => vi.fn())
const toggle = vi.hoisted(() => vi.fn())

vi.mock('@/lib/userscripts/ui-client', () => ({
  userscriptClient: {
    list,
    errors,
    availability,
    toggle,
    create: vi.fn(),
    remove: vi.fn(),
    removeAll: vi.fn(),
    importZip: vi.fn(),
    getProject: vi.fn(),
  },
}))

function summary(uuid: string, name: string): ScriptSummary {
  return { uuid, name, enabled: true, matches: ['*://*/*'], fileCount: 1, updatedAt: 1_700_000_000_000 }
}

const OK_AVAILABILITY: UserScriptsAvailability = {
  available: true,
  isFirefox: false,
  chromeMajor: 140,
  guideText: '',
}
const ENGINE_OFF: UserScriptsAvailability = {
  available: false,
  isFirefox: false,
  chromeMajor: 140,
  guideText: 'Chrome ≥138：在扩展详情页开启「Allow User Scripts」开关后即可使用。',
}

let wrapper: VueWrapper

async function mountPanel(): Promise<VueWrapper> {
  const w = mount(UserscriptListPanel)
  await flushPromises()
  await flushPromises()
  return w
}

/** 行内报错入口（旧行为；新设计不应出现） */
const errorChips = () => wrapper.findAll('button').filter((b) => b.text().includes('条报错'))

beforeEach(() => {
  vi.clearAllMocks()
  availability.mockResolvedValue(OK_AVAILABILITY)
  errors.mockResolvedValue([])
})

afterEach(() => {
  wrapper?.unmount()
})

describe('UserscriptListPanel 不承载报错展示', () => {
  it('挂载后不调用 userscriptClient.errors()（报错展示已迁出列表）', async () => {
    list.mockResolvedValue([summary('u1', '脚本A')])
    wrapper = await mountPanel()
    expect(errors).not.toHaveBeenCalled()
  })

  it('有报错的脚本行也不显示行内入口（报错不按脚本逐条复述，归独立标签页）', async () => {
    list.mockResolvedValue([summary('u1', '脚本A'), summary('u2', '脚本B')])
    wrapper = await mountPanel()
    expect(errorChips()).toHaveLength(0)
  })

  it('启停返回 registerError 时列表不出现 per-script 报错提示', async () => {
    list.mockResolvedValue([summary('u1', '脚本A')])
    toggle.mockResolvedValue({ registerError: 'userScripts 引擎不可用：…' })
    wrapper = await mountPanel()
    expect(errorChips()).toHaveLength(0)

    await wrapper.findComponent({ name: 'SwitchRoot' }).vm.$emit('update:modelValue', false)
    await flushPromises()

    expect(toggle).toHaveBeenCalledWith('u1', false)
    expect(errorChips()).toHaveLength(0)
  })

  it('引擎不可用时只显示 availability 横幅，不为每个脚本挂报错入口', async () => {
    availability.mockResolvedValue(ENGINE_OFF)
    list.mockResolvedValue([summary('u1', '脚本A'), summary('u2', '脚本B')])
    wrapper = await mountPanel()

    expect(wrapper.text()).toContain('用户脚本引擎不可用')
    expect(errorChips()).toHaveLength(0)
  })
})
