// UI 组件测试：UserscriptRunLogPanel.vue 的时间线行为。
// 覆盖易回归语义：运行行渲染与错误展开、孤儿错误行、左栏过滤（全部/未归属/脚本）、
// 清空范围跟随选中项（三态 IPC 参数）、深链定位（命中与落空）。
// 边界 mock：ui-client（IPC 客户端）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import UserscriptRunLogPanel from './UserscriptRunLogPanel.vue'
import type {
  RunEndReason,
  ScriptSummary,
  UserScriptErrorRecord,
  UserScriptRunEvent,
  UserScriptRunLogRow
} from '@/lib/userscripts/types'

const runlog = vi.hoisted(() => vi.fn())
const clearErrors = vi.hoisted(() => vi.fn())
const list = vi.hoisted(() => vi.fn())

vi.mock('@/lib/userscripts/ui-client', () => ({
  userscriptClient: { runlog, clearErrors, list },
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

function runRow(over: {
  runId: string
  uuid: string
  name?: string
  time?: number
  url?: string
  savedAt?: number
  events?: UserScriptRunEvent[]
  endedAt?: number
  endReason?: RunEndReason
  errors?: UserScriptErrorRecord[]
}): UserScriptRunLogRow {
  return {
    kind: 'run',
    runId: over.runId,
    uuid: over.uuid,
    name: over.name ?? '某脚本',
    time: over.time ?? 500,
    // 老记录没有这些字段：缺了就整条不写（与 listRunTimeline 的口径一致）
    ...(over.url != null ? { url: over.url } : {}),
    ...(over.savedAt != null ? { savedAt: over.savedAt } : {}),
    ...(over.events ? { events: over.events } : {}),
    ...(over.endedAt != null ? { endedAt: over.endedAt, endReason: over.endReason } : {}),
    errors: over.errors ?? [],
  }
}

function errRow(recOver: Partial<UserScriptErrorRecord> & { message: string }): UserScriptRunLogRow {
  return { kind: 'error', record: rec(recOver) }
}

function summary(uuid: string, name: string, savedAt = 0): ScriptSummary {
  return { uuid, name, enabled: true, matches: [], savedAt, group: '' }
}

let wrapper: VueWrapper

async function mountPanel(
  props: { focusUuid?: string | null; focusSeq?: number } = {},
): Promise<VueWrapper> {
  const w = mount(UserscriptRunLogPanel, { props })
  await flushPromises()
  await flushPromises()
  return w
}

/** 左栏按钮：首项恒为「全部」 */
const navButtons = () => wrapper.findAll('nav button')
/** 左栏按钮上的名称（每个按钮第一个 span 就是名字，后面是计数徽标） */
const navNames = () => navButtons().map((b) => b.find('span').text())
/** 按名称点左栏某一项 */
async function clickNav(name: string): Promise<void> {
  const target = navButtons().find((b) => b.find('span').text() === name)
  if (!target) throw new Error(`左栏没有「${name}」项`)
  await target.trigger('click')
  await flushPromises()
}
/** 点右上角清空按钮（文案随选中项变：清空全部 / 清空该脚本 / 清空未归属） */
async function clickClear(): Promise<void> {
  const btn = wrapper.findAll('button').find((b) => b.text().startsWith('清空'))
  if (!btn) throw new Error('没有找到清空按钮')
  await btn.trigger('click')
  await flushPromises()
}

/** 右栏时间线文本（不含左栏导航——导航里永远列着全部脚本名，断言行内容时必须排除） */
const timelineText = () => wrapper.find('.run-log-timeline').text()

beforeEach(() => {
  vi.clearAllMocks()
  clearErrors.mockResolvedValue(undefined)
  list.mockResolvedValue([])
})

afterEach(() => {
  wrapper?.unmount()
})

describe('UserscriptRunLogPanel 时间线', () => {
  it('运行行按数据顺序渲染（倒序由 listRunTimeline 保证）；无错误的运行标「无错误」', async () => {
    runlog.mockResolvedValue([
      runRow({ runId: 'r2', uuid: 'u1', name: '脚本A', time: 300 }),
      runRow({ runId: 'r1', uuid: 'u2', name: '脚本B', time: 100 }),
    ])
    wrapper = await mountPanel()

    expect(wrapper.text()).toContain('脚本A')
    expect(wrapper.text()).toContain('脚本B')
    // 只陈述「没挂错误」，不暗示脚本跑完了（运行日志没有结束状态）
    expect(wrapper.text()).toContain('无错误')
    expect(wrapper.text()).not.toContain('正常结束')
    // 无错误时不渲染错误徽标
    expect(wrapper.text()).not.toContain('个错误')
  })

  it('运行行显示运行所在页面；老记录没有 url 就不多出一行', async () => {
    runlog.mockResolvedValue([
      runRow({ runId: 'r1', uuid: 'u1', name: '脚本A', url: 'https://a.example/x' }),
      runRow({ runId: 'r2', uuid: 'u2', name: '脚本B' }),
    ])
    wrapper = await mountPanel()

    const items = wrapper.findAll('.run-log-timeline > li')
    expect(items[0].text()).toContain('https://a.example/x')
    expect(items[1].text()).not.toContain('https://')
  })

  it('运行跑的源码版本与脚本当前已保存的版本不一致 → 标「旧版源码」（无从判断的一律不标）', async () => {
    runlog.mockResolvedValue([
      runRow({ runId: 'r1', uuid: 'u1', name: '脚本A', savedAt: 100 }),
      runRow({ runId: 'r2', uuid: 'u2', name: '脚本B', savedAt: 200 }),
      runRow({ runId: 'r3', uuid: 'u3', name: '脚本C' }), // 老记录：没有 savedAt
      runRow({ runId: 'r4', uuid: 'u4', name: '脚本D', savedAt: 300 }), // 脚本已删：列表里没有
    ])
    list.mockResolvedValue([
      summary('u1', '脚本A', 999), // 那之后又被改过
      summary('u2', '脚本B', 200), // 与运行时刻一致
      summary('u3', '脚本C', 500),
    ])
    wrapper = await mountPanel()

    const items = wrapper.findAll('.run-log-timeline > li')
    expect(items[0].text()).toContain('旧版源码')
    expect(items[1].text()).not.toContain('旧版源码')
    expect(items[2].text()).not.toContain('旧版源码')
    expect(items[3].text()).not.toContain('旧版源码')
  })

  it('有错误的运行显示错误数徽标，点开看明细；孤儿错误行带阶段徽标与信息', async () => {
    runlog.mockResolvedValue([
      errRow({ uuid: null, name: '幽灵脚本', phase: 'register', message: '注册失败详情' }),
      runRow({
        runId: 'r1',
        uuid: 'u1',
        name: '脚本A',
        time: 300,
        errors: [rec({ uuid: 'u1', name: '脚本A', phase: 'runtime', message: 'boom-stack' })],
      }),
    ])
    wrapper = await mountPanel()

    // 默认折叠：只显示数量，不显示错误内容
    expect(wrapper.text()).toContain('1 个错误')
    expect(wrapper.text()).toContain('注册失败详情')
    expect(wrapper.text()).not.toContain('boom-stack')

    // 点徽标展开：错误明细（message）可见
    const toggle = wrapper.findAll('button').find((b) => b.text().includes('个错误'))
    await toggle!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('boom-stack')
  })

  it('运行时间线：事件恒显示（摘要已脱敏）；错误仅在展开时并入同一列表', async () => {
    runlog.mockResolvedValue([
      runRow({
        runId: 'r1',
        uuid: 'u1',
        name: '脚本A',
        time: 1000,
        events: [
          { kind: 'fetch', detail: 'GET https://a.example/api', time: 1200 },
          { kind: 'store.set', detail: 'token', time: 1400 },
        ],
        errors: [
          rec({ uuid: 'u1', name: '脚本A', phase: 'runtime', message: 'boom-late', time: 1300 }),
        ],
      }),
    ])
    wrapper = await mountPanel()

    const before = timelineText()
    expect(before).toContain('fetch')
    expect(before).toContain('GET https://a.example/api')
    expect(before).toContain('store.set')
    // 默认不并入错误（避免刷屏）
    expect(before).not.toContain('boom-late')

    const toggle = wrapper.findAll('button').find((b) => b.text().includes('个错误'))
    await toggle!.trigger('click')
    await flushPromises()

    // 展开后错误并入同一时间线，并按时刻排在两条事件之间
    const after = timelineText()
    expect(after).toContain('boom-late')
    expect(after.indexOf('fetch')).toBeLessThan(after.indexOf('boom-late'))
    expect(after.indexOf('boom-late')).toBeLessThan(after.indexOf('store.set'))
  })

  it('结束节点：有 endedAt 才画（含原因与存活时长）；老记录与仍在跑的沉默', async () => {
    runlog.mockResolvedValue([
      runRow({
        runId: 'r1',
        uuid: 'u1',
        name: '脚本A',
        time: 1000,
        endedAt: 96_000,
        endReason: 'navigated',
      }),
      runRow({ runId: 'r2', uuid: 'u2', name: '脚本B', time: 2000 }),
    ])
    wrapper = await mountPanel()

    const items = wrapper.findAll('.run-log-timeline > li')
    expect(items[0].text()).toContain('已结束')
    expect(items[0].text()).toContain('页面导航离开')
    expect(items[0].text()).toContain('1 分 35 秒')
    // 无 endedAt：不臆断「结束了」，也不编造时长
    expect(items[1].text()).not.toContain('已结束')
    expect(items[1].text()).not.toContain('存活')
  })

  it('左栏过滤：全部 / 未归属（仅当有孤儿错误）/ 各脚本，选中后右栏只剩该范围', async () => {
    runlog.mockResolvedValue([
      runRow({ runId: 'r1', uuid: 'u1', name: '脚本A' }),
      errRow({ uuid: null, name: '幽灵脚本', phase: 'bridge', message: '孤儿错误' }),
      errRow({ uuid: 'u1', name: '脚本A', phase: 'runtime', message: 'A 的落单错误' }),
    ])
    wrapper = await mountPanel()

    expect(navNames()).toEqual(['全部', '未归属', '脚本A'])
    expect(wrapper.text()).toContain('孤儿错误')

    await clickNav('脚本A')
    expect(timelineText()).toContain('A 的落单错误')
    expect(timelineText()).not.toContain('孤儿错误')

    await clickNav('未归属')
    expect(timelineText()).toContain('孤儿错误')
    expect(timelineText()).not.toContain('A 的落单错误')
  })

  it('列表里有但暂无日志的脚本也出现在左栏（置灰、计数 0），排在日志脚本之后', async () => {
    runlog.mockResolvedValue([runRow({ runId: 'r1', uuid: 'u1', name: '脚本A' })])
    list.mockResolvedValue([summary('u1', '脚本A'), summary('u2', '脚本B（未运行）')])
    wrapper = await mountPanel()

    // 顺序：全部 → 有日志的脚本A → 无日志的脚本B
    expect(navNames()).toEqual(['全部', '脚本A', '脚本B（未运行）'])
    const noLogBtn = navButtons().find((b) => b.find('span').text() === '脚本B（未运行）')!
    expect(noLogBtn.classes()).toContain('opacity-50')
    expect(noLogBtn.text()).toContain('0') // 计数徽标为 0
  })

  it('一条日志都没有时双栏仍常驻：左栏列出全部脚本，右栏给一句空提示', async () => {
    runlog.mockResolvedValue([])
    list.mockResolvedValue([summary('u1', '脚本A'), summary('u2', '脚本B')])
    wrapper = await mountPanel()

    // 左栏可见（脚本列表一直在），不是整页空态
    expect(navNames()).toEqual(['全部', '脚本A', '脚本B'])
    // 右栏给空提示而非空白
    expect(wrapper.text()).toContain('暂无运行记录')
  })

  it('清空范围跟随选中项：全部 → 该脚本 → 未归属（三态各自对应 IPC 参数）', async () => {
    runlog.mockResolvedValue([
      runRow({ runId: 'r1', uuid: 'u1', name: '脚本A' }),
      errRow({ uuid: null, name: '幽灵脚本', phase: 'register', message: 'o1' }),
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

  it('深链 focusUuid 命中 → 直接过滤到该脚本', async () => {
    runlog.mockResolvedValue([
      runRow({ runId: 'r1', uuid: 'u1', name: '脚本A' }),
      runRow({ runId: 'r2', uuid: 'u2', name: '脚本B' }),
    ])
    wrapper = await mountPanel({ focusUuid: 'u2' })

    // 单脚本视图刻意不重复显示脚本名（showNameInRows），断言只剩该脚本的一行
    expect(wrapper.findAll('.run-log-timeline > li')).toHaveLength(1)
  })

  it('深链目标在列表里但暂无日志 → 落到该脚本的空视图（左栏同样可见、不静默无反应）', async () => {
    runlog.mockResolvedValue([runRow({ runId: 'r1', uuid: 'u1', name: '脚本A' })])
    list.mockResolvedValue([summary('u9', '脚本Z')])
    wrapper = await mountPanel({ focusUuid: 'u9' })

    // 不再是无记录提示，而是定位到该脚本自己的空视图
    expect(wrapper.text()).not.toContain('当前没有运行记录，已切到全部')
    // 左栏里有这个脚本（含尚无日志的），且右栏给一句空提示
    expect(navNames()).toContain('脚本Z')
    expect(wrapper.text()).toContain('脚本「脚本Z」暂未运行')
    expect(wrapper.findAll('.run-log-timeline > li')).toHaveLength(0)
  })

  it('深链目标既不在日志也不在列表（已彻底删除）→ 落「全部」并说明一句', async () => {
    runlog.mockResolvedValue([runRow({ runId: 'r1', uuid: 'u1', name: '脚本A' })])
    list.mockResolvedValue([]) // 列表里也没有
    wrapper = await mountPanel({ focusUuid: 'u9' })

    // 列表查不到名字时回退短 uuid，但说明文案与回落全部视图都成立
    expect(wrapper.text()).toContain('脚本「u9」当前没有运行记录')
    expect(wrapper.text()).toContain('已切到全部')
    expect(wrapper.text()).toContain('脚本A') // 已回落全部视图
  })

  it('脚本删除后宿主递增 reloadSeq → 重拉且正在看的分组消失时回落全部', async () => {
    runlog.mockResolvedValue([runRow({ runId: 'r1', uuid: 'u1', name: '脚本A' })])
    wrapper = await mountPanel()
    await clickNav('脚本A')

    // 脚本被删：它的运行行已随删除清掉
    runlog.mockResolvedValue([runRow({ runId: 'r9', uuid: 'u2', name: '脚本B' })])
    wrapper.setProps({ reloadSeq: 1 })
    await flushPromises()
    await flushPromises()

    expect(navNames()).toContain('全部')
    expect(wrapper.text()).toContain('脚本B') // 重拉过
  })
})
