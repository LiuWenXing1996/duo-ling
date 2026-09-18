// UI 组件测试：UserscriptListPanel.vue 的两组易回归语义。
//
// A. **列表不承载报错展示**：报错属历史信息，由独立「错误日志」标签页承载，
//    脚本列表本身不展示任何脚本报错 —— 环境级问题（引擎不可用）只靠 availability 横幅一处兜底。
// B. **新建脚本动线**：新建**不**跳编辑器（不 emit edit），改为在该行标「刚新建」，
//    点该行「编辑」进过一次即摘标。
//    注：A 与 B 在「注册失败要不要告不告诉用户」上交过锋 —— 结论是**不告**（见下方 B 组第 3 条）。
// 边界 mock：ui-client（IPC 客户端）；按钮 / 弹窗 / 开关用真实 shadcn 组件。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import UserscriptListPanel from './UserscriptListPanel.vue'
import type { ScriptSummary, UserScriptsAvailability } from '@/lib/userscripts/types'

const list = vi.hoisted(() => vi.fn())
const errors = vi.hoisted(() => vi.fn())
const availability = vi.hoisted(() => vi.fn())
const create = vi.hoisted(() => vi.fn())
const toggle = vi.hoisted(() => vi.fn())

vi.mock('@/lib/userscripts/ui-client', () => ({
  userscriptClient: {
    list,
    errors,
    availability,
    create,
    toggle,
    getProject: vi.fn(),
    remove: vi.fn(),
    removeAll: vi.fn(),
    importZip: vi.fn(),
    clearErrors: vi.fn(),
  },
}))

const summary = (uuid: string, name: string): ScriptSummary => ({
  uuid,
  name,
  enabled: true,
  matches: ['https://a.example/*'],
  fileCount: 1,
  updatedAt: 0,
})

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

/** 列表行（编辑按钮 → 行容器）：取行内文本 */
function rowText(i: number): string {
  const btn = wrapper.findAll('button[title="编辑脚本"]')[i]
  return btn?.element.closest('.bg-card')?.textContent ?? ''
}

const buttonByText = (text: string) => wrapper.findAll('button').find((b) => b.text() === text)!

/** 行内报错入口（旧行为；新设计不应出现） */
const errorChips = () => wrapper.findAll('button').filter((b) => b.text().includes('条报错'))

beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue([summary('u1', '已有脚本')])
  errors.mockResolvedValue([])
  availability.mockResolvedValue(OK_AVAILABILITY)
  create.mockResolvedValue({ uuid: 'u2', name: '新建的脚本 1' })
  toggle.mockResolvedValue({})
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

describe('UserscriptListPanel 新建脚本', () => {
  it('新建后不跳编辑器，且该行标「刚新建」（其他行不标）', async () => {
    wrapper = await mountPanel()
    expect(rowText(0)).not.toContain('刚新建')

    // 创建后列表多出这一行
    list.mockResolvedValue([summary('u2', '新建的脚本 1'), summary('u1', '已有脚本')])
    await buttonByText('添加脚本').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('edit')).toBeUndefined()
    expect(rowText(0)).toContain('新建的脚本 1')
    expect(rowText(0)).toContain('刚新建')
    expect(rowText(1)).not.toContain('刚新建')
  })

  it('点该行「编辑」：emit edit，同时摘掉「刚新建」标', async () => {
    wrapper = await mountPanel()
    list.mockResolvedValue([summary('u2', '新建的脚本 1'), summary('u1', '已有脚本')])
    await buttonByText('添加脚本').trigger('click')
    await flushPromises()

    await wrapper.findAll('button[title="编辑脚本"]')[0]!.trigger('click')
    expect(wrapper.emitted('edit')).toEqual([['u2', '新建的脚本 1']])
    expect(rowText(0)).not.toContain('刚新建')
  })

  // 与上游同名的用例不同：上游断言「列表页弹出注册失败警告」，这里断言相反 ——
  // 注册失败**不在列表页报错**（报错属历史信息，归错误日志标签页；环境态由 availability 横幅兜底，
  // 在列表再说一遍是同一件事两次）。数据已落库这一点由「仍然标刚新建」体现。
  it('注册失败仍标「刚新建」，但不在列表页报错（归错误日志标签页）', async () => {
    wrapper = await mountPanel()
    list.mockResolvedValue([summary('u2', '新建的脚本 1'), summary('u1', '已有脚本')])
    create.mockResolvedValue({ uuid: 'u2', name: '新建的脚本 1', registerError: '未开启 Allow User Scripts' })
    await buttonByText('添加脚本').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('edit')).toBeUndefined()
    expect(rowText(0)).toContain('刚新建')
    expect(wrapper.text()).not.toContain('不会注入页面')
  })

  it('刷新列表不摘标（会话内标记，刷新重算的是数据不是这个标）', async () => {
    wrapper = await mountPanel()
    list.mockResolvedValue([summary('u2', '新建的脚本 1'), summary('u1', '已有脚本')])
    await buttonByText('添加脚本').trigger('click')
    await flushPromises()

    await wrapper.find('button[title="刷新列表"]').trigger('click')
    await flushPromises()

    expect(rowText(0)).toContain('刚新建')
  })
})
