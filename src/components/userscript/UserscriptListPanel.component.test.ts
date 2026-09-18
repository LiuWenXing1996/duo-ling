// UI 组件测试：UserscriptListPanel.vue 的「新建脚本」动线。
// 只验证一条规则：新建**不**跳编辑器（不 emit edit），改为在该行标「刚新建」，
// 点该行「编辑」进过一次即摘标。不测样式。
// 边界 mock：ui-client（IPC 客户端）；按钮 / 弹窗 / 开关用真实 shadcn 组件。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import UserscriptListPanel from './UserscriptListPanel.vue'
import type { ScriptSummary } from '@/lib/userscripts/types'

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

let wrapper: VueWrapper

async function mountPanel(): Promise<VueWrapper> {
  const w = mount(UserscriptListPanel)
  await flushPromises()
  return w
}

/** 列表行（编辑按钮 → 行容器）：取行内文本 */
function rowText(i: number): string {
  const btn = wrapper.findAll('button[title="编辑脚本"]')[i]
  return btn?.element.closest('.bg-card')?.textContent ?? ''
}

const buttonByText = (text: string) => wrapper.findAll('button').find((b) => b.text() === text)!

beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue([summary('u1', '已有脚本')])
  errors.mockResolvedValue([])
  availability.mockResolvedValue({
    available: true,
    isFirefox: false,
    chromeMajor: 138,
    guideText: '',
  })
  create.mockResolvedValue({ uuid: 'u2', name: '新建的脚本 1' })
  toggle.mockResolvedValue({})
})

afterEach(() => {
  wrapper?.unmount()
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

  it('注册失败仍标「刚新建」并给出警告（数据已建，只是没跑起来）', async () => {
    wrapper = await mountPanel()
    list.mockResolvedValue([summary('u2', '新建的脚本 1'), summary('u1', '已有脚本')])
    create.mockResolvedValue({ uuid: 'u2', name: '新建的脚本 1', registerError: '未开启 Allow User Scripts' })
    await buttonByText('添加脚本').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('edit')).toBeUndefined()
    expect(rowText(0)).toContain('刚新建')
    expect(wrapper.text()).toContain('不会注入页面：未开启 Allow User Scripts')
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
