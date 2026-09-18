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
const subscribeAvailability = vi.hoisted(() =>
  vi.fn((cb: (a: UserScriptsAvailability) => void) => vi.fn()),
)

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
  subscribeAvailability,
}))

const summary = (uuid: string, name: string): ScriptSummary => ({
  uuid,
  name,
  enabled: true,
  matches: ['https://a.example/*'],
  fileCount: 1,
  updatedAt: 0,
  buildOk: true,
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

describe('UserscriptListPanel 横幅自动刷新', () => {
  it('订阅广播：SW 推送 availabilityChanged 时横幅直接更新（无需手动重查）', async () => {
    availability.mockResolvedValue(ENGINE_OFF)
    wrapper = await mountPanel()
    expect(wrapper.text()).toContain('用户脚本引擎不可用')

    // 用户在扩展管理页开了开关 → SW 轮询发现并广播 → 横幅自动消掉
    const cb = subscribeAvailability.mock.calls.at(-1)![0] as (a: UserScriptsAvailability) => void
    cb(OK_AVAILABILITY)
    await flushPromises()
    expect(wrapper.text()).not.toContain('用户脚本引擎不可用')
  })

  it('卸载时退订广播', async () => {
    wrapper = await mountPanel()
    const unsub = subscribeAvailability.mock.results.at(-1)!.value as ReturnType<typeof vi.fn>
    wrapper.unmount()
    expect(unsub).toHaveBeenCalled()
  })
})

describe('UserscriptListPanel 搜索 / 筛选 / 排序', () => {
  const searchInput = () => wrapper.find('input[placeholder="搜索名称或匹配规则…"]')

  it('按名称过滤行，计数行显示「筛选显示 N 个」', async () => {
    list.mockResolvedValue([summary('u1', '脚本A'), summary('u2', '脚本B')])
    wrapper = await mountPanel()
    expect(wrapper.findAll('button[title="编辑脚本"]')).toHaveLength(2)

    await searchInput().setValue('脚本A')
    expect(wrapper.findAll('button[title="编辑脚本"]')).toHaveLength(1)
    expect(rowText(0)).toContain('脚本A')
    expect(wrapper.text()).toContain('筛选显示 1 个')
  })

  it('按匹配规则也能搜到（搜索域含 matches）', async () => {
    list.mockResolvedValue([summary('u1', '脚本A'), summary('u2', '脚本B')])
    wrapper = await mountPanel()
    await searchInput().setValue('a.example')
    expect(wrapper.findAll('button[title="编辑脚本"]')).toHaveLength(2)
  })

  it('状态筛选「已停用」只显示停用脚本', async () => {
    const disabled = { ...summary('u1', '脚本A'), enabled: false }
    list.mockResolvedValue([summary('u2', '脚本B'), disabled])
    wrapper = await mountPanel()

    const chip = wrapper.findAll('button').find((b) => b.text().includes('已停用'))!
    await chip.trigger('click')
    await flushPromises()

    expect(wrapper.findAll('button[title="编辑脚本"]')).toHaveLength(1)
    expect(rowText(0)).toContain('脚本A')
  })

  it('搜索 / 筛选滤空时提示调整条件，而非误导为「还没有脚本」', async () => {
    wrapper = await mountPanel()
    await searchInput().setValue('不存在的脚本')
    expect(wrapper.text()).toContain('没有匹配的脚本')
    expect(wrapper.text()).not.toContain('还没有用户脚本')
  })

  it('默认按更新时间新在前（createdAt 同值时保持原序）', async () => {
    const older = { ...summary('u1', '旧脚本'), updatedAt: 100 }
    const newer = { ...summary('u2', '新脚本'), updatedAt: 200 }
    list.mockResolvedValue([older, newer])
    wrapper = await mountPanel()
    expect(rowText(0)).toContain('新脚本')
    expect(rowText(1)).toContain('旧脚本')
  })
})

describe('UserscriptListPanel 批量启停', () => {
  it('全部停用：只对启用中的脚本逐条 toggle，已停用的不动', async () => {
    const disabled = { ...summary('u1', '脚本A'), enabled: false }
    list.mockResolvedValue([summary('u2', '脚本B'), disabled])
    wrapper = await mountPanel()

    // reka-ui 的菜单在 happy-dom 里只认键盘开（trigger 上发 ArrowDown），内容 portal 到 body —— 去 document 上找菜单项
    await wrapper.find('button[title="批量启用 / 停用"]').trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('全部停用'),
    )!
    expect(item).toBeDefined()
    item.click()
    await flushPromises()

    expect(toggle).toHaveBeenCalledTimes(1)
    expect(toggle).toHaveBeenCalledWith('u2', false)
    expect(toggle).not.toHaveBeenCalledWith('u1', false)
  })
})

describe('UserscriptListPanel 行紧凑化', () => {
  it('文件数与更新时间收进匹配规则同一行（元信息是 span，与 matches 同容器）', async () => {
    const s = { ...summary('u1', '脚本A'), updatedAt: 1758200000000 }
    list.mockResolvedValue([s])
    wrapper = await mountPanel()
    const meta = wrapper.findAll('span').find((el) => el.text().includes('1 个文件'))!
    expect(meta.element.parentElement?.textContent).toContain('a.example')
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
