// UI 组件测试：TabActivityPanel.vue 的活动历史视图（左栏标签页列表 + 右栏该页活动轴）。
// 覆盖易回归语义：左栏以**存续表**为准（没跑过脚本的页也在列表里）、右栏只显示选中那一页的记录、
// 生命周期端点只在记到时刻时才画（缺时刻不拿别的时刻顶上）、**动作与错误直接平铺在轴上**
// （没有卡片要展开）、无归属的记录不出口（左栏也不给它们留格子）；刷新 / 地址变更 / 记录开关
// 与动作、请求同轴混排（缺时刻的节点也不编钟点）；删除 / 清空走确认弹窗（确认后才发命令）。
// 边界 mock：ui-client（IPC 客户端）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import TabActivityPanel from './TabActivityPanel.vue'
import type {
  RunEndReason,
  TabEventRecord,
  TabSessionRecord,
  UserScriptErrorRecord,
  UserScriptRunEvent,
  UserScriptRunLogEntry,
  UserScriptRunLogRow
} from '@/lib/userscripts/types'
import type { NetCaptureRecord, NetRecordSession } from '@/lib/userscripts/net-record-protocol'

const runlog = vi.hoisted(() => vi.fn())
const tabSessions = vi.hoisted(() => vi.fn())
const tabTimeline = vi.hoisted(() => vi.fn())
const tabActivityClear = vi.hoisted(() => vi.fn())
const tabActivityDelete = vi.hoisted(() => vi.fn())
const tabActivityDisable = vi.hoisted(() => vi.fn())
const netCaptureState = vi.hoisted(() => vi.fn())
/**
 * 面板取选中页的数据只走一条命令（六类行在库里同表，故一次拉回 —— 见 tab-captures 的单测）。
 * 这里把它拆成几个「填数据」的抓手：各用例只关心其中一样时，不必写全。
 */
const pageEvents = vi.hoisted(() => vi.fn())
const pageCaptures = vi.hoisted(() => vi.fn())
const pageRuns = vi.hoisted(() => vi.fn())
const pageActs = vi.hoisted(() => vi.fn())
const pageErrors = vi.hoisted(() => vi.fn())

vi.mock('@/lib/userscripts/ui-client', () => ({
  userscriptClient: {
    runlog,
    tabSessions,
    tabTimeline,
    tabActivityClear,
    tabActivityDelete,
    tabActivityDisable,
    netCaptureState,
  },
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

/** 左栏计数用的运行行（全量时间线的产物）：运行条 + 它挂着的错误 */
function runLogRow(over: {
  runId: string
  uuid?: string
  name?: string
  time?: number
  tabSessionId?: string
  errors?: UserScriptErrorRecord[]
}): UserScriptRunLogRow {
  return {
    kind: 'run',
    runId: over.runId,
    uuid: over.uuid ?? 'u1',
    name: over.name ?? '脚本A',
    time: over.time ?? 500,
    ...(over.tabSessionId != null ? { tabSessionId: over.tabSessionId } : {}),
    errors: over.errors ?? [],
  }
}

/** 选中页的运行条目（整根轴的 runs 组）：只用来给动作行挂脚本名、算被截断的动作数 */
function runEntry(over: {
  runId: string
  uuid?: string
  name?: string
  time?: number
  eventCount?: number
  endedAt?: number
  endReason?: RunEndReason
}): UserScriptRunLogEntry {
  return {
    runId: over.runId,
    uuid: over.uuid ?? 'u1',
    name: over.name ?? '脚本A',
    time: over.time ?? 500,
    ...(over.eventCount != null ? { eventCount: over.eventCount } : {}),
    ...(over.endedAt != null ? { endedAt: over.endedAt } : {}),
    ...(over.endReason != null ? { endReason: over.endReason } : {}),
  }
}

/** 选中页的一个动作（整根轴的 acts 组） */
function act(runId: string, over: Partial<UserScriptRunEvent> = {}): {
  runId: string
  event: UserScriptRunEvent
} {
  return {
    runId,
    event: {
      kind: 'fetch',
      detail: 'GET https://a.example/api',
      time: 600,
      ...over,
    },
  }
}

function session(over: TabSessionRecord): TabSessionRecord {
  return over
}

/** 存续轴上的事件（刷新 / 地址变更 / 记录开关）：活动轴的一类节点 */
function tabEvent(over: {
  kind: TabEventRecord['kind']
  tabSessionId: string
  time?: number
  url?: string
}): TabEventRecord {
  return {
    tabSessionId: over.tabSessionId,
    kind: over.kind,
    // 时刻缺省就不带：划断补的那条「结束记录」本就没有时刻，mock 也不该替它编一个
    ...(over.time != null ? { time: over.time } : {}),
    ...(over.url != null ? { url: over.url } : {}),
  }
}

/** 造一条录制采样（融合进活动轴的接口数据） */
function netRec(over: Partial<NetCaptureRecord> = {}): NetCaptureRecord {
  return {
    host: 'a.example',
    sessionId: 'sess-1',
    type: 'fetch',
    method: 'GET',
    url: 'https://a.example/api',
    reqHeaders: {},
    reqBody: null,
    status: 200,
    respHeaders: {},
    respBody: '{}',
    t: 600,
    ...over,
  }
}

/** 造一个录制会话（挂在某存续行上） */
function netSess(over: Partial<NetRecordSession> = {}): NetRecordSession {
  return {
    id: 'sess-1',
    tabId: 1,
    host: 'a.example',
    url: 'https://a.example/x',
    title: '示例页',
    startedAt: 550,
    ...over,
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
 * 右栏活动轴文本（左栏永远列着全部标签页名，断言行内容时必须排除左栏）。
 * 一个节点都画不出来时整条轴不渲染，这时给空串 —— 它本就不该在，而不是坏了。
 */
const timelineText = (): string => {
  const el = wrapper.find('.tab-activity-timeline')
  return el.exists() ? el.text() : ''
}

/** 右栏整体文本（含卡头，轴为空时也该能看到状态与说明） */
const detailText = () => wrapper.find('[data-testid="tab-activity-detail"]').text()

beforeEach(() => {
  vi.clearAllMocks()
  runlog.mockResolvedValue([])
  tabSessions.mockResolvedValue([])
  pageEvents.mockResolvedValue([])
  pageCaptures.mockResolvedValue([])
  pageRuns.mockResolvedValue([])
  pageActs.mockResolvedValue([])
  pageErrors.mockResolvedValue([])
  // 面板按选中页发一条命令；这里照旧让用例分块填数据
  tabTimeline.mockImplementation(async () => ({
    events: await pageEvents(),
    captures: await pageCaptures(),
    runs: await pageRuns(),
    acts: await pageActs(),
    errors: await pageErrors(),
  }))
  tabActivityClear.mockResolvedValue(undefined)
  tabActivityDelete.mockResolvedValue(undefined)
  tabActivityDisable.mockResolvedValue({ tabId: 1, recording: false })
  netCaptureState.mockResolvedValue({ sessions: [] })
})

afterEach(() => {
  wrapper?.unmount()
  document.body.innerHTML = ''
})

describe('TabActivityPanel 活动历史', () => {
  it('左栏以存续表为准：没跑过脚本的页也在列表里', async () => {
    tabSessions.mockResolvedValue([
      session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x', createdAt: 100 }),
    ])
    wrapper = await mountPanel()

    // 左栏：这一页列出来了，摘要写「无运行记录」（不是 0 次运行的另一种说法）
    expect(tabButtons()).toHaveLength(1)
    expect(tabButtons()[0].text()).toContain('a.example')
    expect(tabButtons()[0].text()).toContain('无运行记录')

    // 右栏：卡头是这一页自己（地址 + 生命周期端点），记到了就画
    expect(detailText()).toContain('a.example')
    expect(detailText()).toContain('页面打开')
  })

  it('默认选中最近有活动的那一页；右栏只显示这一页的动作与错误', async () => {
    tabSessions.mockResolvedValue([
      session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x', createdAt: 100 }),
      session({ tabSessionId: 't2', tabId: 2, url: 'https://b.example/y', createdAt: 200 }),
    ])
    runlog.mockResolvedValue([
      runLogRow({ runId: 'r1', tabSessionId: 't1', name: '脚本A', time: 500 }),
      runLogRow({ runId: 'r2', tabSessionId: 't2', name: '脚本B', time: 900 }),
    ])
    // 服务端按页给数据：t1 有脚本A 的动作，t2 有脚本B 的动作
    tabTimeline.mockImplementation(async (id: string) =>
      id === 't1'
        ? { events: [], captures: [], runs: [runEntry({ runId: 'r1', name: '脚本A' })], acts: [act('r1')], errors: [] }
        : { events: [], captures: [], runs: [runEntry({ runId: 'r2', name: '脚本B' })], acts: [act('r2')], errors: [] }
    )
    wrapper = await mountPanel()

    // t2 的活动更近 → 默认选中它，右栏只有它的动作
    expect(timelineText()).toContain('脚本B')
    expect(timelineText()).not.toContain('脚本A')

    await clickTab('a.example')
    expect(timelineText()).toContain('脚本A')
    expect(timelineText()).not.toContain('脚本B')
  })

  it('动作平铺在轴上并带脚本名前缀（不必展开任何卡片）', async () => {
    tabSessions.mockResolvedValue([
      session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' }),
    ])
    pageRuns.mockResolvedValue([runEntry({ runId: 'r1', name: '脚本甲', eventCount: 2 })])
    pageActs.mockResolvedValue([
      act('r1', { kind: 'fetch', detail: 'GET https://a.example/list', time: 700 }),
      act('r1', { kind: 'store.set', detail: 'token', time: 720 }),
    ])
    wrapper = await mountPanel()

    const text = timelineText()
    expect(text).toContain('脚本甲')
    expect(text).toContain('fetch')
    expect(text).toContain('GET https://a.example/list')
    expect(text).toContain('store.set')
    // 没有「展开 / 收起」这类入口：平铺后不存在折叠态
    expect(wrapper.findAll('button').some((b) => b.text() === '展开')).toBe(false)
  })

  it('被截断的动作不挂在某张卡上，改在轴尾说一句', async () => {
    tabSessions.mockResolvedValue([
      session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' }),
    ])
    pageRuns.mockResolvedValue([runEntry({ runId: 'r1', name: '脚本甲', eventCount: 5 })])
    pageActs.mockResolvedValue([act('r1', { time: 700 })])
    wrapper = await mountPanel()

    expect(detailText()).toContain('另有 4 个动作已省略')
  })

  it('错误平铺在轴上：阶段徽标 + 脚本名 + 消息 + 可复制的错误 ID', async () => {
    tabSessions.mockResolvedValue([
      session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' }),
    ])
    pageErrors.mockResolvedValue([rec({ message: 'boom-stack', name: '脚本甲' })])
    wrapper = await mountPanel()

    const text = timelineText()
    expect(text).toContain('运行期')
    expect(text).toContain('脚本甲')
    expect(text).toContain('boom-stack')
  })

  it('左栏计数把「挂在运行上的错误」也算进去', async () => {
    tabSessions.mockResolvedValue([
      session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' }),
    ])
    runlog.mockResolvedValue([
      runLogRow({ runId: 'r1', tabSessionId: 't1', time: 500, errors: [rec({ message: 'boom' })] }),
    ])
    wrapper = await mountPanel()

    expect(tabButtons()[0].text()).toContain('跑过 1 次')
    expect(tabButtons()[0].text()).toContain('错误 1 条')
  })

  it('无归属的记录（注册 / 依赖抓取失败）在这一页不出口：左栏也不为它留格子', async () => {
    // 这类记录没有 tabSessionId，活动轴按页查不到它们
    runlog.mockResolvedValue([{ kind: 'error', record: rec({ message: 'reg', uuid: null, name: '脚本A' }) }])
    wrapper = await mountPanel()

    expect(tabButtons()).toHaveLength(0)
    expect(wrapper.text()).toContain('还没有标签页记录')
  })

  it('生命周期端点记到时刻才画：缺时刻就不画，也不拿别的时刻顶上', async () => {
    tabSessions.mockResolvedValue([
      session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' }),
    ])
    wrapper = await mountPanel()

    // 缺时刻就是缺：卡头不挂「打开时刻未知」这类恒空的话（记录改为被动后它必空）
    expect(detailText()).not.toContain('打开时刻未知')
    // 一个节点都画不出来：活动轴整块不出现（不是画一条「页面打开 · 未知」顶上）
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
    runlog.mockResolvedValue([runLogRow({ runId: 'r2', tabSessionId: 't2', time: 900 })])
    wrapper = await mountPanel()

    await wrapper.find('[data-testid="tab-activity-delete"]').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('删除这一页的活动记录')

    dialogButton('删除').click()
    await flushPromises()
    expect(tabActivityDelete).toHaveBeenCalledWith('t2')
  })

  it('只刷过页、一次脚本都没跑的页：轴上有刷新条目', async () => {
    tabSessions.mockResolvedValue([session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' })])
    pageEvents.mockResolvedValue([tabEvent({ kind: 'reload', tabSessionId: 't1', time: 700 })])
    wrapper = await mountPanel()

    expect(timelineText()).toContain('页面刷新')
  })

  it('地址变更条目带新地址；刷新条目只说刷新（地址没变，不重复报一遍）', async () => {
    tabSessions.mockResolvedValue([session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' })])
    pageEvents.mockResolvedValue([
      tabEvent({ kind: 'url', tabSessionId: 't1', time: 800, url: 'https://b.example/p' }),
      tabEvent({ kind: 'reload', tabSessionId: 't1', time: 700 }),
    ])
    wrapper = await mountPanel()

    const text = timelineText()
    expect(text).toContain('地址变更')
    expect(text).toContain('https://b.example/p')
    expect(text).toContain('页面刷新')
  })

  it('刷新与动作在同一根轴上按时刻混排（最新在前）', async () => {
    tabSessions.mockResolvedValue([session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' })])
    pageRuns.mockResolvedValue([runEntry({ runId: 'r1', name: '脚本A' })])
    pageActs.mockResolvedValue([act('r1', { time: 500 })])
    pageEvents.mockResolvedValue([tabEvent({ kind: 'reload', tabSessionId: 't1', time: 900 })])
    wrapper = await mountPanel()

    const text = timelineText()
    // 刷新（900）比这次动作（500）新：两类节点同轴，只按时刻排、互不从属
    expect(text.indexOf('页面刷新')).toBeLessThan(text.indexOf('脚本A'))
  })

  it('切页就换一份数据：按选中页发命令，右栏画的就是它回的那些', async () => {
    tabSessions.mockResolvedValue([
      session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' }),
      session({ tabSessionId: 't2', tabId: 2, url: 'https://b.example/y' }),
    ])
    runlog.mockResolvedValue([runLogRow({ runId: 'r2', tabSessionId: 't2', name: '脚本B', time: 900 })])
    // 服务端按页给数据（真正的「别页不串」在按 tabSessionId 索引那侧，见 tab-captures /
    // store 的单测）：这里让 t1 有一条刷新、t2 什么都没有，验的是面板「按页取、换页就换」
    tabTimeline.mockImplementation(async (id: string) =>
      id === 't1'
        ? {
            events: [tabEvent({ kind: 'reload', tabSessionId: 't1', time: 950 })],
            captures: [],
            runs: [],
            acts: [],
            errors: [],
          }
        : { events: [], captures: [], runs: [], acts: [], errors: [] }
    )
    wrapper = await mountPanel()

    // 默认选中 t2（活动更近）：它没有事件
    expect(tabTimeline).toHaveBeenCalledWith('t2')
    expect(timelineText()).not.toContain('页面刷新')

    await clickTab('a.example')
    expect(tabTimeline).toHaveBeenCalledWith('t1')
    expect(timelineText()).toContain('页面刷新')
  })

  it('记录开关的启停也在轴上：开始记录 / 结束记录，与动作同轴按时刻排', async () => {
    tabSessions.mockResolvedValue([session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' })])
    pageRuns.mockResolvedValue([runEntry({ runId: 'r1', name: '脚本A' })])
    pageActs.mockResolvedValue([act('r1', { time: 500 })])
    pageEvents.mockResolvedValue([
      tabEvent({ kind: 'recordOn', tabSessionId: 't1', time: 100 }),
      tabEvent({ kind: 'recordOff', tabSessionId: 't1', time: 900 }),
    ])
    wrapper = await mountPanel()

    const text = timelineText()
    expect(text).toContain('开始记录')
    expect(text).toContain('结束记录')
    // 最新在前：结束记录（900）→ 动作（500）→ 开始记录（100）
    expect(text.indexOf('结束记录')).toBeLessThan(text.indexOf('脚本A'))
    expect(text.indexOf('脚本A')).toBeLessThan(text.indexOf('开始记录'))
  })

  it('结束记录缺时刻（划断补的那条）：如实写「时刻未知」，不编一个钟点', async () => {
    tabSessions.mockResolvedValue([
      session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x', ended: true }),
    ])
    pageEvents.mockResolvedValue([tabEvent({ kind: 'recordOff', tabSessionId: 't1' })])
    wrapper = await mountPanel()

    const text = timelineText()
    expect(text).toContain('结束记录')
    expect(text).toContain('时刻未知')
  })

  it('缺时刻的节点排在最前（最新端）：与存储层「升序排末尾」的口径互为倒数', async () => {
    tabSessions.mockResolvedValue([session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' })])
    pageRuns.mockResolvedValue([runEntry({ runId: 'r1', name: '脚本A' })])
    pageActs.mockResolvedValue([act('r1', { time: 500 })])
    pageEvents.mockResolvedValue([
      tabEvent({ kind: 'recordOn', tabSessionId: 't1', time: 100 }),
      tabEvent({ kind: 'recordOff', tabSessionId: 't1' }),
    ])
    wrapper = await mountPanel()

    const text = timelineText()
    expect(text.indexOf('结束记录')).toBeLessThan(text.indexOf('脚本A'))
  })

  it('刚打开记录、什么都还没发生的页：右栏就是它的轴（一条「开始记录」）', async () => {
    tabSessions.mockResolvedValue([session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' })])
    pageEvents.mockResolvedValue([tabEvent({ kind: 'recordOn', tabSessionId: 't1', time: 300 })])
    wrapper = await mountPanel()

    expect(timelineText()).toContain('开始记录')
  })

  it('选中页录到的请求铺在轴上（融合自原「接口数据」面板）', async () => {
    tabSessions.mockResolvedValue([session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' })])
    pageCaptures.mockResolvedValue([
      netRec({ url: 'https://a.example/api/list', sessionId: 's1', tabSessionId: 't1' }),
    ])
    wrapper = await mountPanel()

    // 轴上只有采样本身，没有「接口录制」那种段头卡
    const text = timelineText()
    expect(text).toContain('/api/list')
    expect(text).not.toContain('接口录制')
  })

  it('正在录的页：已实时落库的采样照样铺在轴上（不必等停止归档）', async () => {
    tabSessions.mockResolvedValue([session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' })])
    // 会话要等停止 / 关页才归档进会话表，采样却是实时落库的
    netCaptureState.mockResolvedValue({
      sessions: [netSess({ id: 'live1', tabSessionId: 't1', tabId: 7, startedAt: 550 })],
    })
    pageCaptures.mockResolvedValue([
      netRec({ url: 'https://a.example/api/list', sessionId: 'live1', tabSessionId: 't1' }),
    ])
    wrapper = await mountPanel()

    expect(timelineText()).toContain('/api/list')
  })

  it('录到的请求直接铺在轴上，点单条才看请求头与响应结构', async () => {
    tabSessions.mockResolvedValue([session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' })])
    pageCaptures.mockResolvedValue([
      netRec({
        url: 'https://a.example/api/list',
        sessionId: 's1',
        tabSessionId: 't1',
        reqHeaders: { 'x-req': '1' },
        respBody: '{"ok":true}',
      }),
    ])
    wrapper = await mountPanel()

    // 平铺：请求行本身就在轴上；明细仍要点开才出
    const text = timelineText()
    expect(text).toContain('/api/list')
    expect(text).not.toContain('x-req')

    // 点这一条请求展开详情
    const row = wrapper.findAll('button').find((b) => b.text().includes('/api/list'))
    if (!row) throw new Error('没有找到请求行按钮')
    await row.trigger('click')
    await flushPromises()
    expect(detailText()).toContain('x-req')
    expect(detailText()).toContain('{"ok":true}')
  })

  it('录到的请求与刷新、动作同轴混排：各自按发生时刻落位，不受段归属约束', async () => {
    tabSessions.mockResolvedValue([session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' })])
    pageRuns.mockResolvedValue([runEntry({ runId: 'r1', name: '脚本A' })])
    pageActs.mockResolvedValue([act('r1', { time: 500 })])
    pageEvents.mockResolvedValue([tabEvent({ kind: 'reload', tabSessionId: 't1', time: 900 })])
    pageCaptures.mockResolvedValue([
      netRec({ url: 'https://a.example/api/mid', sessionId: 's1', tabSessionId: 't1', t: 700 }),
    ])
    wrapper = await mountPanel()

    // 最新在前：刷新（900）→ 请求（700）→ 动作（500）
    const text = timelineText()
    expect(text.indexOf('页面刷新')).toBeLessThan(text.indexOf('/api/mid'))
    expect(text.indexOf('/api/mid')).toBeLessThan(text.indexOf('脚本A'))
  })

  it('正在录的页：卡头给「停止记录」，点了用实时 tabId 发 tabActivityDisable（关的就是同一枚开关）', async () => {
    tabSessions.mockResolvedValue([session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' })])
    netCaptureState.mockResolvedValue({ sessions: [netSess({ id: 's1', tabSessionId: 't1', tabId: 7 })] })
    wrapper = await mountPanel()

    const stop = wrapper.find('[data-testid="tab-activity-stop"]')
    expect(stop.exists()).toBe(true)
    await stop.trigger('click')
    await flushPromises()
    // 命令走的是会话里的实时 tabId（7），不是存续行的 tabId
    expect(tabActivityDisable).toHaveBeenCalledWith(7)
  })

  it('没在录的页不给「停止记录」按钮', async () => {
    tabSessions.mockResolvedValue([session({ tabSessionId: 't1', tabId: 1, url: 'https://a.example/x' })])
    wrapper = await mountPanel()

    expect(wrapper.find('[data-testid="tab-activity-stop"]').exists()).toBe(false)
  })
})
