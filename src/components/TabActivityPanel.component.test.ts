// UI 组件测试：TabActivityPanel.vue 的活动历史视图（左栏标签页列表 + 右栏该页活动时间线）。
// 覆盖易回归语义：左栏以**存续表**为准（没跑过脚本的页也在列表里）、右栏只显示选中那一页的记录、
// 生命周期端点只在记到时刻时才画（缺时刻不拿别的时刻顶上）、展开才看错误明细、
// 归不到标签页的记录落「未知标签页」档、空态；刷新 / 地址变更与运行条同轴混排；
// 删除 / 清空走确认弹窗（确认后才发命令）。
// 边界 mock：ui-client（IPC 客户端）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import TabActivityPanel from './TabActivityPanel.vue'
import type {
  TabEventRecord,
  TabSessionRecord,
  UserScriptErrorRecord,
  UserScriptRunLogRow
} from '@/lib/userscripts/types'

const runlog = vi.hoisted(() => vi.fn())
const runEvents = vi.hoisted(() => vi.fn())
const tabSessions = vi.hoisted(() => vi.fn())
const tabEvents = vi.hoisted(() => vi.fn())
const tabActivityClear = vi.hoisted(() => vi.fn())
const tabActivityDelete = vi.hoisted(() => vi.fn())

vi.mock('@/lib/userscripts/ui-client', () => ({
  userscriptClient: { runlog, runEvents, tabSessions, tabEvents, tabActivityClear, tabActivityDelete },
}))

let seq = 0
/** 造一条错误记录；id 取 8 位以上（面板只展示前 8 位） */
function rec(over: Partial<UserScriptErrorRecord> & { message: string }): UserScriptErrorRecord {
  seq += 1
  return {
    id: `abcdef${String(seq).padStart(2, '0')}-full`,
    uuid: 'u1',
    name: '脚本A',
    phase: 'runtime',
    time: 1000 + seq,
    ...over,
  }
}

function runRow(over: {
  runId: string
  uuid?: string
  name?: string
  time?: number
  url?: string
  tabSessionId?: string
  eventCount?: number
  errors?: UserScriptErrorRecord[]
}): UserScriptRunLogRow {
  return {
    kind: 'run',
    runId: over.runId,
    uuid: over.uuid ?? 'u1',
    name: over.name ?? '脚本A',
    time: over.time ?? 500,
    // 老记录没有这些字段：缺了就整条不写（与 listRunTimeline 的口径一致）
    ...(over.url != null ? { url: over.url } : {}),
    ...(over.tabSessionId != null ? { tabSessionId: over.tabSessionId } : {}),
    ...(over.eventCount != null ? { eventCount: over.eventCount } : {}),
    errors: over.errors ?? [],
  }
}

function session(over: TabSessionRecord): TabSessionRecord {
  return over
}

/** 存续轴上的事件（刷新 / 地址变更）：右栏时间线的第三类节点 */
function tabEvent(over: {
  kind: 'reload' | 'url'
  tabSessionId: string
  time?: number
  url?: string
}): TabEventRecord {
  return {
    tabSessionId: over.tabSessionId,
    kind: over.kind,
    time: over.time ?? 900,
    ...(over.url != null ? { url: over.url } : {}),
  }
}

let wrapper: VueWrapper

async function mountPanel(): Promise<VueWrapper> {
  // 确认弹窗经 Portal teleport 到 body 且异步挂载：attachTo 让面板自身也在 body 里（查询走
  // [role="dialog"] 限定到弹窗，避免误命中面板自己的「删除」按钮）。
  const w = mount(TabActivityPanel, { attachTo: document.body })
  await flushPromises()
  await flushPromises()
  return w
}

/** 左栏标签页按钮（首项 = 最近有活动的那一页） */
const tabButtons = () => wrapper.findAll('nav button')

/** 点左栏含某段文字的标签页 */
async function clickTab(text: string): Promise<void> {
  const target = tabButtons().find((b) => b.text().includes(text))
  if (!target) throw new Error(`左栏没有含「${text}」的标签页`)
  await target.trigger('click')
  await flushPromises()
}

/**
 * 右栏时间线文本（左栏永远列着全部标签页名，断言行内容时必须排除左栏）。
 * 一个节点都画不出来时整条时间线不渲染，这时给空串 —— 它本就不该在，而不是坏了。
 */
const timelineText = (): string => {
  const el = wrapper.find('.tab-activity-timeline')
  return el.exists() ? el.text() : ''
}

/** 右栏整体文本（含卡头，时间线为空时也该能看到状态与说明） */
const detailText = () => wrapper.find('.min-w-0.flex-1.overflow-y-auto').text()

beforeEach(() => {
  vi.clearAllMocks()
  runlog.mockResolvedValue([])
  runEvents.mockResolvedValue([])
  tabSessions.mockResolvedValue([])
  tabEvents.mockResolvedValue([])
  tabActivityClear.mockResolvedValue(undefined)
  tabActivityDelete.mockResolvedValue(undefined)
})

afterEach(() => {
  wrapper?.unmount()
  document.body.innerHTML = ''
})

describe('TabActivityPanel 活动历史', () => {
  it('左栏以存续表为准：没跑过脚本的页也在列表里，右栏如实说明「还没有运行记录」', async () => {
    tabSessions.mockResolvedValue([
      session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x', createdAt: 100 }),
    ])
    wrapper = await mountPanel()

    // 左栏：这一页列出来了，摘要写「无运行记录」（不是 0 次运行的另一种说法）
    expect(tabButtons()).toHaveLength(1)
    expect(tabButtons()[0].text()).toContain('a.example')
    expect(tabButtons()[0].text()).toContain('无运行记录')

    // 右栏：说明为什么没有记录，而不是一片空白
    expect(detailText()).toContain('a.example')
    expect(detailText()).toContain('这一页还没有运行记录')
    // 生命周期端点记到了就画
    expect(detailText()).toContain('页面打开')
  })

  it('默认选中最近有活动的那一页；右栏只显示这一页的运行', async () => {
    tabSessions.mockResolvedValue([
      session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x', createdAt: 100 }),
      session({ tabSessionId: 't2', tabId: 2, url: 'https://b.example/y', createdAt: 200 }),
    ])
    runlog.mockResolvedValue([
      runRow({ runId: 'r1', tabSessionId: 't1', name: '脚本A', time: 500 }),
      runRow({ runId: 'r2', tabSessionId: 't2', name: '脚本B', time: 900 }),
    ])
    wrapper = await mountPanel()

    // t2 的活动更近 → 默认选中它，右栏只有它的运行
    expect(timelineText()).toContain('脚本B')
    expect(timelineText()).not.toContain('脚本A')

    await clickTab('a.example')
    expect(timelineText()).toContain('脚本A')
    expect(timelineText()).not.toContain('脚本B')
  })

  it('生命周期端点记到时刻才画：缺时刻就不画，也不拿别的时刻顶上', async () => {
    tabSessions.mockResolvedValue([
      session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' }),
    ])
    wrapper = await mountPanel()

    // 缺时刻就是缺：卡头不挂「打开时刻未知」这类恒空的话（记录改为被动后它必空）
    expect(detailText()).not.toContain('打开时刻未知')
    // 一个节点都画不出来：时间线整块不出现（不是画一条「页面打开 · 未知」顶上）
    expect(wrapper.find('.tab-activity-timeline').exists()).toBe(false)
  })

  it('已关闭的页：状态写「已关闭」，关闭时刻未知时不编时刻', async () => {
    tabSessions.mockResolvedValue([
      session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x', createdAt: 100, ended: true }),
    ])
    wrapper = await mountPanel()

    expect(detailText()).toContain('已关闭')
    expect(detailText()).toContain('关闭时刻未知')
    expect(timelineText()).not.toContain('页面关闭')
  })

  it('展开某次运行才显示错误明细（默认只报数量）', async () => {
    tabSessions.mockResolvedValue([session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' })])
    runlog.mockResolvedValue([
      runRow({
        runId: 'r1',
        tabSessionId: 't1',
        errors: [rec({ message: 'boom-stack' })],
      }),
    ])
    wrapper = await mountPanel()

    expect(timelineText()).toContain('1 个错误')
    expect(detailText()).not.toContain('boom-stack')

    const expand = wrapper.findAll('button').find((b) => b.text() === '展开')
    if (!expand) throw new Error('没有找到展开按钮')
    await expand.trigger('click')
    await flushPromises()

    expect(detailText()).toContain('boom-stack')
  })

  it('归不到标签页的记录落「未知标签页」档：左栏出现该档，点它能看到那些记录', async () => {
    // 老记录没有 tabSessionId（扩展刚重载那会儿记的）
    runlog.mockResolvedValue([runRow({ runId: 'r1', name: '脚本A', time: 500 })])
    wrapper = await mountPanel()

    expect(tabButtons()).toHaveLength(1)
    expect(tabButtons()[0].text()).toContain('未知标签页')
    expect(detailText()).toContain('没有记下所在标签页')
    expect(timelineText()).toContain('脚本A')
  })

  it('表里已查不到、日志里还有的标签页也列出来（老记录，名字回落到运行自己的地址）', async () => {
    runlog.mockResolvedValue([
      runRow({ runId: 'r1', tabSessionId: 'gone', url: 'https://c.example/y', time: 500 }),
    ])
    wrapper = await mountPanel()

    expect(tabButtons()[0].text()).toContain('c.example')
    expect(detailText()).toContain('存续表里已查不到这一页')
    // 不把它当成「还开着的页」：这一条只是日志里的残迹
    expect(detailText()).not.toContain('活动中')
  })

  /** 确认弹窗里的按钮（限定在 role=dialog 内，避免误命中面板自己的「删除」按钮） */
  function dialogButton(text: string): HTMLButtonElement {
    const dialog = document.body.querySelector('[role="dialog"]')
    if (!dialog) throw new Error('确认弹窗没出现')
    const btn = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
    if (!btn) throw new Error(`弹窗里没有「${text}」按钮`)
    return btn as HTMLButtonElement
  }

  it('空态：既没有存续行也没有日志时，两侧各给一句说明', async () => {
    wrapper = await mountPanel()

    expect(wrapper.text()).toContain('还没有标签页记录')
    // 空态得指出去哪开记录，否则用户只会以为这个面板坏了
    expect(wrapper.text()).toContain('活动记录')
    expect(wrapper.text()).toContain('从左边选一个标签页看它的活动')
  })

  it('清空：先过确认弹窗，确认后才发命令', async () => {
    tabSessions.mockResolvedValue([
      session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' }),
    ])
    wrapper = await mountPanel()

    await wrapper.find('[data-testid="tab-activity-clear"]').trigger('click')
    await flushPromises()

    // 弹窗出现，但还没发命令
    expect(document.body.textContent).toContain('清空活动历史')
    expect(tabActivityClear).not.toHaveBeenCalled()

    dialogButton('清空').click()
    await flushPromises()
    expect(tabActivityClear).toHaveBeenCalledTimes(1)
  })

  it('清空取消：不发命令', async () => {
    tabSessions.mockResolvedValue([
      session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' }),
    ])
    wrapper = await mountPanel()

    await wrapper.find('[data-testid="tab-activity-clear"]').trigger('click')
    await flushPromises()
    dialogButton('取消').click()
    await flushPromises()
    expect(tabActivityClear).not.toHaveBeenCalled()
  })

  it('删除：按选中那一页的 tabSessionId 发命令（默认选最近有活动的那页）', async () => {
    tabSessions.mockResolvedValue([
      session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' }),
      session({ tabSessionId: 't2', tabId: 2, url: 'https://b.example/y' }),
    ])
    runlog.mockResolvedValue([runRow({ runId: 'r2', tabSessionId: 't2', time: 900 })])
    wrapper = await mountPanel()

    await wrapper.find('[data-testid="tab-activity-delete"]').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('删除这一页的活动记录')

    dialogButton('删除').click()
    await flushPromises()
    expect(tabActivityDelete).toHaveBeenCalledWith('t2')
  })

  it('「未知标签页」档不给删除入口（它不是一页，谈不上删它）', async () => {
    runlog.mockResolvedValue([runRow({ runId: 'r1', name: '脚本A' })])
    wrapper = await mountPanel()

    expect(tabButtons()[0].text()).toContain('未知标签页')
    expect(wrapper.find('[data-testid="tab-activity-delete"]').exists()).toBe(false)
  })

  it('只刷过页、一次脚本都没跑的页：时间线上有刷新条目，不再说「还没有运行记录」', async () => {
    tabSessions.mockResolvedValue([session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' })])
    tabEvents.mockResolvedValue([tabEvent({ kind: 'reload', tabSessionId: 't1', time: 700 })])
    wrapper = await mountPanel()

    expect(timelineText()).toContain('页面刷新')
    expect(detailText()).not.toContain('还没有运行记录')
  })

  it('地址变更条目带新地址；刷新条目只说刷新（地址没变，不重复报一遍）', async () => {
    tabSessions.mockResolvedValue([session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' })])
    tabEvents.mockResolvedValue([
      tabEvent({ kind: 'url', tabSessionId: 't1', time: 800, url: 'https://b.example/p' }),
      tabEvent({ kind: 'reload', tabSessionId: 't1', time: 700 }),
    ])
    wrapper = await mountPanel()

    const text = timelineText()
    expect(text).toContain('地址变更')
    expect(text).toContain('https://b.example/p')
    expect(text).toContain('页面刷新')
  })

  it('刷新与运行在同一根时间轴上按时刻混排（最新在前）', async () => {
    tabSessions.mockResolvedValue([session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' })])
    runlog.mockResolvedValue([runRow({ runId: 'r1', tabSessionId: 't1', name: '脚本A', time: 500 })])
    tabEvents.mockResolvedValue([tabEvent({ kind: 'reload', tabSessionId: 't1', time: 900 })])
    wrapper = await mountPanel()

    const text = timelineText()
    // 刷新（900）比这次运行（500）新：两类节点同轴，只按时刻排、互不从属
    expect(text.indexOf('页面刷新')).toBeLessThan(text.indexOf('脚本A'))
  })

  it('别页的事件不串进这一页（时间线只收 tabSessionId 相等的事件）', async () => {
    tabSessions.mockResolvedValue([
      session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' }),
      session({ tabSessionId: 't2', tabId: 2, url: 'https://b.example/y' }),
    ])
    runlog.mockResolvedValue([runRow({ runId: 'r2', tabSessionId: 't2', name: '脚本B', time: 900 })])
    tabEvents.mockResolvedValue([tabEvent({ kind: 'reload', tabSessionId: 't2', time: 950 })])
    wrapper = await mountPanel()

    // 默认选中 t2（活动更近）：它的刷新在
    expect(timelineText()).toContain('页面刷新')

    await clickTab('a.example')
    expect(timelineText()).not.toContain('页面刷新')
  })
})
