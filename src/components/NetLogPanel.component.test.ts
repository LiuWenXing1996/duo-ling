// UI 组件测试：NetLogPanel.vue（「接口数据」调试面板）。
//
// 守这条面板特有的链路：站点清单 = 记录 ∪ 归档会话 → 选中站点按**录制会话**分节 →
// 节内**一条请求一行**（不按接口聚合）、展开才看采样明细；以及两个写动作都走命令面
// （停录 / 清空），清空必须先过确认弹窗。
//
// 边界 mock：
//   · netlog-db（IndexedDB 在 happy-dom 下不可用）—— 读侧全 mock，断言只看渲染；
//   · ui-client —— 只用到 netCaptureState / netCaptureDisable / netLogClear 三条命令。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { NetCaptureRecord, NetRecordSession } from '@/lib/userscripts/net-record-protocol'

const listCapturedHosts = vi.fn()
const listSessionHosts = vi.fn()
const listCapturesByHost = vi.fn()
const listSessionsByHost = vi.fn()
const countCapturesByHost = vi.fn()

vi.mock('@/lib/userscripts/netlog-db', () => ({
  listCapturedHosts: () => listCapturedHosts(),
  listSessionHosts: () => listSessionHosts(),
  listCapturesByHost: (...a: unknown[]) => listCapturesByHost(...a),
  listSessionsByHost: (...a: unknown[]) => listSessionsByHost(...a),
  countCapturesByHost: (...a: unknown[]) => countCapturesByHost(...a),
}))

const netCaptureState = vi.fn()
const netCaptureDisable = vi.fn()
const netLogClear = vi.fn()

vi.mock('@/lib/userscripts/ui-client', () => ({
  userscriptClient: {
    netCaptureState: () => netCaptureState(),
    netCaptureDisable: (...a: unknown[]) => netCaptureDisable(...a),
    netLogClear: (...a: unknown[]) => netLogClear(...a),
  },
}))

import NetLogPanel from './NetLogPanel.vue'

const HOST = 'example.com'

/** 一条采样（默认 GET /api/list 200） */
function rec(over: Partial<NetCaptureRecord> = {}): NetCaptureRecord {
  return {
    id: 1,
    host: HOST,
    sessionId: 's1',
    type: 'fetch',
    url: `https://${HOST}/api/list`,
    method: 'GET',
    reqHeaders: { accept: 'application/json' },
    reqBody: null,
    status: 200,
    respHeaders: { 'content-type': 'application/json' },
    respBody: '{ data: [], total: 0 }',
    t: 1_760_000_000_000,
    ...over,
  }
}

/** 一个录制会话（默认进行中） */
function session(over: Partial<NetRecordSession> = {}): NetRecordSession {
  return {
    id: 's1',
    tabId: 7,
    host: HOST,
    url: `https://${HOST}/orders`,
    title: '订单列表',
    startedAt: 1_760_000_000_000,
    ...over,
  }
}

const wrappers: VueWrapper[] = []

async function mountPanel(): Promise<VueWrapper> {
  const w = mount(NetLogPanel, { attachTo: document.body })
  wrappers.push(w)
  await flushPromises()
  return w
}

const recordRows = (w: VueWrapper) => w.findAll('[data-testid^="net-log-record-"]')

beforeEach(() => {
  listCapturedHosts.mockResolvedValue([])
  listSessionHosts.mockResolvedValue([])
  listCapturesByHost.mockResolvedValue([])
  listSessionsByHost.mockResolvedValue([])
  countCapturesByHost.mockResolvedValue(0)
  netCaptureState.mockResolvedValue({ sessions: [] })
  netCaptureDisable.mockResolvedValue({ sessions: [] })
  netLogClear.mockResolvedValue({ host: HOST })
})

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers.length = 0
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('接口数据面板 · 站点清单', () => {
  it('没有任何数据：左栏空态，右栏没有清空按钮', async () => {
    const w = await mountPanel()
    expect(w.find('[data-testid="net-log-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="net-log-clear"]').exists()).toBe(false)
  })

  it('站点 = 记录 ∪ 归档会话（只录到 0 条请求的会话也上榜），各带条数', async () => {
    listCapturedHosts.mockResolvedValue(['b.test', 'a.test'])
    listSessionHosts.mockResolvedValue(['c.test', 'a.test'])
    countCapturesByHost.mockImplementation(async (h: string) => (h === 'a.test' ? 3 : 0))

    const w = await mountPanel()
    // 合并去重且排序：a.test 不复现两遍
    expect(w.findAll('[data-testid^="net-log-site-"]').map((el) => el.attributes('data-testid'))).toEqual([
      'net-log-site-a.test',
      'net-log-site-b.test',
      'net-log-site-c.test',
    ])
    expect(w.find('[data-testid="net-log-site-a.test"]').text()).toContain('3 条')
    expect(w.find('[data-testid="net-log-site-c.test"]').text()).toContain('0 条')
  })

  it('正在录制的站点带状态点，没在录的不带', async () => {
    listCapturedHosts.mockResolvedValue(['a.test', 'b.test'])
    netCaptureState.mockResolvedValue({ sessions: [session({ id: 's9', host: 'a.test', tabId: 3 })] })

    const w = await mountPanel()
    const dotOf = (h: string) =>
      w.find(`[data-testid="net-log-site-${h}"]`).find('[aria-label="正在录制"]').exists()
    expect(dotOf('a.test')).toBe(true)
    expect(dotOf('b.test')).toBe(false)
  })
})

describe('接口数据面板 · 会话分节与请求行', () => {
  it('按会话分节，节内一条请求一行（不按接口聚合，同路径各占一行）', async () => {
    listCapturedHosts.mockResolvedValue([HOST])
    listSessionsByHost.mockResolvedValue([session()])
    listCapturesByHost.mockResolvedValue([
      rec({ id: 1, url: `https://${HOST}/api/list?a=1` }),
      rec({ id: 2, url: `https://${HOST}/api/list?a=2` }),
      rec({ id: 3, method: 'POST', url: `https://${HOST}/api/order`, status: 500 }),
    ])

    const w = await mountPanel()
    expect(w.findAll('[data-testid^="net-log-session-"]')).toHaveLength(1)
    expect(w.find('[data-testid="net-log-session-s1"]').text()).toContain('订单列表')

    // 三条记录三行，同路径不去重、也没有 ×N 计数
    const rows = recordRows(w)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.attributes('data-testid'))).toEqual([
      'net-log-record-1',
      'net-log-record-2',
      'net-log-record-3',
    ])
    expect(w.text()).not.toContain('×2')
    // 每行带各自的状态徽标（POST 那行是 500）
    expect(rows[2].text()).toContain('500')
  })

  it('展开请求行才渲染采样明细（默认收起，省得一次铺满）', async () => {
    listCapturedHosts.mockResolvedValue([HOST])
    listSessionsByHost.mockResolvedValue([session()])
    listCapturesByHost.mockResolvedValue([rec({ url: `https://${HOST}/api/list?token=***` })])

    const w = await mountPanel()
    expect(w.text()).not.toContain('/api/list?token=***')

    await recordRows(w)[0].find('button').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('/api/list?token=***')
    expect(w.text()).toContain('请求头')
  })

  it('没有归档会话的采样单独垫底一节，不丢', async () => {
    listCapturedHosts.mockResolvedValue([HOST])
    listSessionsByHost.mockResolvedValue([])
    listCapturesByHost.mockResolvedValue([rec({ sessionId: 'ghost' })])

    const w = await mountPanel()
    const sections = w.findAll('[data-testid^="net-log-session-"]')
    expect(sections).toHaveLength(1)
    expect(sections[0].attributes('data-testid')).toBe('net-log-session-ghost')
    expect(sections[0].text()).toContain('无会话记录')
  })
})

describe('接口数据面板 · 写动作走命令面', () => {
  it('停止某个标签页的录制：按 tabId 上行，已录内容不动（不清记录）', async () => {
    listCapturedHosts.mockResolvedValue([HOST])
    netCaptureState.mockResolvedValue({ sessions: [session({ tabId: 42 })] })

    const w = await mountPanel()
    const row = w.find('[data-testid="net-log-recording-42"]')
    expect(row.exists()).toBe(true)

    await row.find('button').trigger('click')
    await flushPromises()

    expect(netCaptureDisable).toHaveBeenCalledWith(42)
    expect(netLogClear).not.toHaveBeenCalled()
  })

  it('清空该站点：先过确认弹窗，确认后才发命令', async () => {
    listCapturedHosts.mockResolvedValue([HOST])
    listCapturesByHost.mockResolvedValue([rec()])
    countCapturesByHost.mockResolvedValue(1)

    const w = await mountPanel()
    await w.find('[data-testid="net-log-clear"]').trigger('click')
    await flushPromises()

    // 弹窗出现但还没发命令
    expect(document.body.textContent).toContain('清空该站点的录制数据')
    expect(netLogClear).not.toHaveBeenCalled()

    const confirm = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '清空',
    )
    confirm!.click()
    await flushPromises()
    expect(netLogClear).toHaveBeenCalledWith(HOST)
  })

  it('清空取消：不发命令', async () => {
    listCapturedHosts.mockResolvedValue([HOST])
    listCapturesByHost.mockResolvedValue([rec()])
    countCapturesByHost.mockResolvedValue(1)

    const w = await mountPanel()
    await w.find('[data-testid="net-log-clear"]').trigger('click')
    await flushPromises()

    const cancel = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '取消',
    )
    cancel!.click()
    await flushPromises()
    expect(netLogClear).not.toHaveBeenCalled()
  })
})
