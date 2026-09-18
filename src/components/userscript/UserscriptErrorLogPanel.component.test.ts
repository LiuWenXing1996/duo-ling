// UI 组件测试：UserscriptErrorLogPanel.vue 的「按脚本分类」行为。
// 覆盖五类易回归语义：分组与排序（含未归属恒末位）、左栏选中切换右栏范围、
// 清空范围跟随选中项（全部 / 该脚本 / 未归属三态）、深链定位（命中与落空两条路）、
// 宿主要求重拉（脚本被删后 reloadSeq 变，含「正在看的分组消失要回落全部」）。
// 边界 mock：ui-client（IPC 客户端）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import UserscriptErrorLogPanel from './UserscriptErrorLogPanel.vue'
import type { ScriptSummary, UserScriptErrorRecord } from '@/lib/userscripts/types'

const errors = vi.hoisted(() => vi.fn())
const clearErrors = vi.hoisted(() => vi.fn())
const list = vi.hoisted(() => vi.fn())

vi.mock('@/lib/userscripts/ui-client', () => ({
  userscriptClient: { errors, clearErrors, list },
}))

let seq = 0
/** 造一条错误记录；id 取 8 位以上（页面只展示前 8 位） */
function rec(over: Partial<UserScriptErrorRecord> & { message: string }): UserScriptErrorRecord {
  seq += 1
  return {
    id: `abcdef${String(seq).padStart(2, '0')}-full`,
    uuid: null,
    name: '某脚本',
    phase: 'runtime',
    time: 1000 + seq,
    ...over,
  }
}

function summary(uuid: string, name: string): ScriptSummary {
  return { uuid, name, enabled: true, matches: [], fileCount: 1, updatedAt: 0 }
}

let wrapper: VueWrapper

async function mountPanel(
  props: { focusUuid?: string | null; focusSeq?: number } = {},
): Promise<VueWrapper> {
  const w = mount(UserscriptErrorLogPanel, { props })
  await flushPromises()
  await flushPromises()
  return w
}

/** 左栏按钮：首项恒为「全部错误」 */
const navButtons = () => wrapper.findAll('nav button')
/** 左栏按钮上的名称（每个按钮第一个 span 就是名字，后面是计数徽标） */
const navNames = () => navButtons().map((b) => b.find('span').text())
/** 按名称点左栏某一项 */
async function clickNav(name: string): Promise<void> {
  const target = navButtons().find((b) => b.find('span').text() === name)
  if (!target) throw new Error(`左栏没有「${name}」项`)
  await target.trigger('click')
}
/** 点右上角清空按钮（文案随选中项变：清空全部 / 清空该脚本 / 清空未归属） */
async function clickClear(): Promise<void> {
  const btn = wrapper.findAll('button').find((b) => b.text().startsWith('清空'))
  if (!btn) throw new Error('没有找到清空按钮')
  await btn.trigger('click')
  await flushPromises()
}

beforeEach(() => {
  vi.clearAllMocks()
  clearErrors.mockResolvedValue(undefined)
  list.mockResolvedValue([])
})

afterEach(() => {
  wrapper?.unmount()
})

describe('UserscriptErrorLogPanel 按脚本分类', () => {
  it('左栏每个脚本一项、未归属恒排最后；排序按最近错误时间倒序', async () => {
    errors.mockResolvedValue([
      rec({ uuid: 'u1', name: '脚本A', message: 'a-新', time: 300 }),
      rec({ uuid: 'u2', name: '脚本B', message: 'b-新', time: 200 }),
      rec({ uuid: 'u1', name: '脚本A', message: 'a-旧', time: 100 }),
      rec({ uuid: null, name: '幽灵脚本', phase: 'register', message: '孤儿', time: 400 }),
    ])
    wrapper = await mountPanel()

    // 首项「全部错误」，随后 A（最近 300）在 B（200）之前，未归属即使时间最新也排最后
    expect(navNames()).toEqual(['全部错误', '脚本A', '脚本B', '未归属'])
    // 计数徽标 = 该组条数
    expect(navButtons().map((b) => b.find('[data-slot="badge"]').text())).toEqual(['4', '2', '1', '1'])
  })

  it('点左栏脚本 → 右栏只剩该脚本的错误', async () => {
    errors.mockResolvedValue([
      rec({ uuid: 'u1', name: '脚本A', message: '来自A' }),
      rec({ uuid: 'u2', name: '脚本B', message: '来自B' }),
    ])
    wrapper = await mountPanel()
    expect(wrapper.text()).toContain('来自A')
    expect(wrapper.text()).toContain('来自B')

    await clickNav('脚本B')
    expect(wrapper.text()).toContain('来自B')
    expect(wrapper.text()).not.toContain('来自A')
  })

  it('清空范围跟随选中项：全部 → 该脚本 → 未归属（三态各自对应 IPC 参数）', async () => {
    errors.mockResolvedValue([
      rec({ uuid: 'u1', name: '脚本A', message: 'a1' }),
      rec({ uuid: null, name: '幽灵脚本', phase: 'register', message: 'o1' }),
    ])
    wrapper = await mountPanel()

    await clickClear()
    expect(clearErrors).toHaveBeenLastCalledWith(undefined)

    await clickNav('脚本A')
    await clickClear()
    expect(clearErrors).toHaveBeenLastCalledWith('u1')

    await clickNav('未归属')
    await clickClear()
    expect(clearErrors).toHaveBeenLastCalledWith(null)
  })

  it('深链 focusUuid 命中 → 直接选中该脚本分组', async () => {
    errors.mockResolvedValue([
      rec({ uuid: 'u1', name: '脚本A', message: '来自A' }),
      rec({ uuid: 'u2', name: '脚本B', message: '来自B' }),
    ])
    wrapper = await mountPanel({ focusUuid: 'u2' })

    expect(wrapper.text()).toContain('来自B')
    expect(wrapper.text()).not.toContain('来自A')
  })

  it('深链目标当前没有错误 → 落「全部」并说明一句（不静默无反应）', async () => {
    errors.mockResolvedValue([rec({ uuid: 'u1', name: '脚本A', message: '来自A' })])
    list.mockResolvedValue([summary('u9', '脚本Z')])
    wrapper = await mountPanel({ focusUuid: 'u9' })

    expect(wrapper.text()).toContain('脚本Z')
    expect(wrapper.text()).toContain('当前没有错误记录')
    // 仍显示全部错误（没有把视图切成空的）
    expect(wrapper.text()).toContain('来自A')
  })

  it('对同一脚本再次定位（focusSeq 变）也重新选中并刷新', async () => {
    errors.mockResolvedValue([
      rec({ uuid: 'u1', name: '脚本A', message: '来自A' }),
      rec({ uuid: 'u2', name: '脚本B', message: '来自B' }),
    ])
    wrapper = await mountPanel({ focusUuid: 'u1', focusSeq: 1 })
    expect(wrapper.text()).toContain('来自A')

    // 标签页常驻：用户手动切到别的脚本，浮窗又点了同一个脚本行 → seq 变，必须重新定位
    await clickNav('脚本B')
    expect(wrapper.text()).not.toContain('来自A')

    await wrapper.setProps({ focusSeq: 2 })
    await flushPromises()
    expect(wrapper.text()).toContain('来自A')
    expect(wrapper.text()).not.toContain('来自B')
  })

  it('reloadSeq 变（脚本被删）→ 重拉，已消失的分组不再显示', async () => {
    // 显式 time：左栏按最近错误时间倒序（A 更新 → 在 B 前）
    errors.mockResolvedValue([
      rec({ uuid: 'u1', name: '脚本A', message: '来自A', time: 200 }),
      rec({ uuid: 'u2', name: '脚本B', message: '来自B', time: 100 }),
    ])
    wrapper = await mountPanel()
    expect(navNames()).toEqual(['全部错误', '脚本A', '脚本B'])

    // 后台已随删除清掉 u2 的报错记录：重拉只应看到 u1
    errors.mockResolvedValue([rec({ uuid: 'u1', name: '脚本A', message: '来自A' })])
    await wrapper.setProps({ reloadSeq: 1 })
    await flushPromises()

    expect(errors).toHaveBeenCalledTimes(2)
    expect(navNames()).toEqual(['全部错误', '脚本A'])
    expect(wrapper.text()).not.toContain('脚本B')
  })

  it('reloadSeq 变后正在看的分组已消失 → 回落「全部」，不停在空视图', async () => {
    errors.mockResolvedValue([
      rec({ uuid: 'u1', name: '脚本A', message: '来自A' }),
      rec({ uuid: 'u2', name: '脚本B', message: '来自B' }),
    ])
    wrapper = await mountPanel()
    await clickNav('脚本B')
    expect(wrapper.text()).toContain('来自B')

    // 正在看的「脚本B」被删了 → 它的记录一并消失
    errors.mockResolvedValue([rec({ uuid: 'u1', name: '脚本A', message: '来自A' })])
    await wrapper.setProps({ reloadSeq: 1 })
    await flushPromises()

    // 视点回落到「全部」：看到剩下这组，而不是空标题 + 空明细
    expect(wrapper.text()).toContain('来自A')
    expect(wrapper.text()).not.toContain('来自B')
  })

  it('无错误时渲染空态，不出现左栏', async () => {
    errors.mockResolvedValue([])
    wrapper = await mountPanel()

    expect(wrapper.find('nav').exists()).toBe(false)
    expect(wrapper.text()).toContain('暂无错误记录')
  })

  it('拉取失败时给出错误条，空态文案不被误当作「没有错误」', async () => {
    errors.mockRejectedValue(new Error('background 无响应'))
    wrapper = await mountPanel()

    expect(wrapper.text()).toContain('background 无响应')
  })
})
