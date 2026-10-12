// 单测：usePageMonitor（「页面脚本监控」面板侧状态源，对话界面浮层的灵动岛在用）。
//
// 这个 composable 的副作用全挂在 onMounted / onUnmounted 上：不进 setup 直接调用只会拿到几个
// ref，既不建端口、也不注册监听、更不拉首帧。故这里**必须挂载一个空壳组件**才能触发 ——
// 空壳的 setup 里调一次并把返回值接住，断言全走返回值。这是本仓第一例「挂载承载 composable」。
//
// 依赖替身（它依赖面宽，除 vue 与纯类型外一律换替身）：
//   · lib/owning-tab —— 归属解析另有专项测试，这里只控「解析出哪个 tab」；
//   · lib/userscripts/ui-client —— 名字表的唯一来源，用可手控的 deferred 造在途与失败；
//   · lib/data-broadcast —— 接住 subscribeDataChange 的监听器，用来模拟「脚本域数据变了」；
//     use-data-sync 走真实实现，顺带验到「订阅的是 script 域」这条；
//   · chrome.* —— 整体 stub：假 Port（登记 onMessage 监听、接住上行）+ tabs.get + tabs.onUpdated。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { PageErrorItem, PageRunItem, PanelMonitorPush } from '@/shared/extension-ipc'
import type { ScriptSummary } from '@/lib/userscripts/types'

const listMock = vi.hoisted(() => vi.fn())
const owningTabIdMock = vi.hoisted(() => vi.fn())
const subscribeMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/userscripts/ui-client', () => ({
  userscriptClient: { list: () => listMock() },
}))

vi.mock('@/lib/owning-tab', () => ({
  resolveOwningTabId: () => owningTabIdMock(),
}))

vi.mock('@/lib/data-broadcast', () => ({
  subscribeDataChange: (listener: (push: unknown) => void) => subscribeMock(listener),
  broadcastDataChange: () => {},
  broadcastBuildPhase: () => {},
}))

import { usePageMonitor } from './use-page-monitor'

type Monitor = ReturnType<typeof usePageMonitor>

let monitor: Monitor | null = null

/** 空壳：只承载 composable 的 setup 作用域，不渲染任何东西 */
const Shell = defineComponent({
  setup() {
    monitor = usePageMonitor()
    return () => null
  },
})

/** 取出当前挂载实例的返回值（未挂载时调用即用例写错，直接抛） */
function state(): Monitor {
  if (monitor == null) throw new Error('尚未挂载空壳组件')
  return monitor
}

interface FakePort {
  name: string
  onMessage: { addListener: Mock }
  postMessage: Mock
  disconnect: Mock
}

const TAB_ID = 7

let port: FakePort
let tabsGet: Mock
let tabUpdatedAdd: Mock
let tabUpdatedRemove: Mock
let runtimeConnect: Mock
const wrappers: VueWrapper[] = []

function makePort(): FakePort {
  return {
    name: 'duoling:panel',
    onMessage: { addListener: vi.fn() },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
  }
}

/** 挂载空壳并等首帧落地（归属解析 + tabs.get + 首拉名字表都在微任务里收尾） */
async function mountMonitor(): Promise<VueWrapper> {
  monitor = null
  const w = mount(Shell, { attachTo: document.body })
  wrappers.push(w)
  await flushPromises()
  return w
}

/** 面板注册的推送消费者（SW 经端口下行） */
function pushHandler(): (msg: PanelMonitorPush) => void {
  return port.onMessage.addListener.mock.calls[0][0] as (msg: PanelMonitorPush) => void
}

type TabUpdatedHandler = (tabId: number, changeInfo: { url?: string }, tab: { url?: string }) => void

/** 面板注册的标签页导航监听（本 composable 跟随页内导航改地址） */
function tabUpdatedHandler(): TabUpdatedHandler {
  return tabUpdatedAdd.mock.calls[0][0] as TabUpdatedHandler
}

/** 脚本域数据变更的监听器（由 use-data-sync 订阅） */
function dataChangeListener(): (push: unknown) => void {
  return subscribeMock.mock.calls[0][0] as (push: unknown) => void
}

function runItem(uuid: string, runId: string, startedAt = 1): PageRunItem {
  return { uuid, runId, startedAt }
}

function pageError(uuid: string | null, over: Partial<PageErrorItem> = {}): PageErrorItem {
  return { uuid, name: uuid == null ? '' : uuid, message: 'boom', time: 1, runId: 'r1', ...over }
}

function script(uuid: string, name: string): ScriptSummary {
  return { uuid, name, enabled: true, matches: [], savedAt: 1, group: '' }
}

beforeEach(() => {
  port = makePort()
  tabsGet = vi.fn().mockResolvedValue({ id: TAB_ID, url: 'https://a.test/page' })
  tabUpdatedAdd = vi.fn()
  tabUpdatedRemove = vi.fn()
  runtimeConnect = vi.fn(() => port)

  vi.stubGlobal('chrome', {
    runtime: { connect: runtimeConnect },
    tabs: {
      get: tabsGet,
      onUpdated: { addListener: tabUpdatedAdd, removeListener: tabUpdatedRemove },
    },
  })

  owningTabIdMock.mockResolvedValue(TAB_ID)
  listMock.mockResolvedValue([])
  subscribeMock.mockReturnValue(() => {})
  monitor = null
})

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers.length = 0
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('归属认定与页面地址', () => {
  it('按归属标签页取地址，host 由地址解析（含端口）', async () => {
    tabsGet.mockResolvedValue({ id: TAB_ID, url: 'https://sub.a.test:8443/page' })

    await mountMonitor()

    expect(tabsGet).toHaveBeenCalledWith(TAB_ID)
    expect(state().host.value).toBe('sub.a.test:8443')
  })

  it('归属取不到：不查标签页、不发快照请求、host 空', async () => {
    owningTabIdMock.mockResolvedValue(null)

    await mountMonitor()

    expect(tabsGet).not.toHaveBeenCalled()
    expect(port.postMessage).not.toHaveBeenCalled()
    expect(state().host.value).toBe('')
  })

  it('标签页恰好没了：只留 id、地址留空，快照照发', async () => {
    tabsGet.mockRejectedValue(new Error('标签页已关闭'))

    await mountMonitor()

    expect(state().host.value).toBe('')
    expect(port.postMessage).toHaveBeenCalledWith({ t: 'page:snapshot', tabId: TAB_ID })
  })

  it('地址解析不出：host 给空串（不硬显示半截字符串）', async () => {
    tabsGet.mockResolvedValue({ id: TAB_ID, url: 'not a url' })

    await mountMonitor()

    expect(state().host.value).toBe('')
  })
})

describe('挂载与端口', () => {
  it('挂载后连监控端口，并向上行拉一次本 tab 的快照', async () => {
    await mountMonitor()

    expect(runtimeConnect).toHaveBeenCalledWith({ name: 'duoling:panel' })
    expect(port.postMessage).toHaveBeenCalledWith({ t: 'page:snapshot', tabId: TAB_ID })
  })

  it('端口连不上（SW 未起）：不炸，面板仍可读', async () => {
    runtimeConnect.mockImplementation(() => {
      throw new Error('SW 未起')
    })

    await mountMonitor()

    expect(state().visible.value).toBe(false)
  })
})

describe('推送消费（只认本载体归属的标签页）', () => {
  it('别处的推送一律丢弃', async () => {
    await mountMonitor()
    const push = pushHandler()

    push({ t: 'page:runstart', tabId: 9, run: runItem('u1', 'r1') })
    push({ t: 'page:error', tabId: 9, error: pageError('u1') })

    expect(state().runs.value).toEqual([])
    expect(state().errors.value).toEqual([])
    expect(state().visible.value).toBe(false)
  })

  it('运行开始：新的前插；同 uuid 重复广播覆盖为最新并移到最前', async () => {
    await mountMonitor()
    const push = pushHandler()

    push({ t: 'page:runstart', tabId: TAB_ID, run: runItem('a', 'r1', 10) })
    push({ t: 'page:runstart', tabId: TAB_ID, run: runItem('b', 'r2', 20) })
    expect(state().runs.value.map((r) => r.uuid)).toEqual(['b', 'a'])

    push({ t: 'page:runstart', tabId: TAB_ID, run: runItem('a', 'r9', 30) })
    expect(state().runs.value).toEqual([
      { uuid: 'a', runId: 'r9', startedAt: 30 },
      { uuid: 'b', runId: 'r2', startedAt: 20 },
    ])
  })

  it('错误：最新在前', async () => {
    await mountMonitor()
    const push = pushHandler()

    push({ t: 'page:error', tabId: TAB_ID, error: pageError('a', { message: 'first', time: 1 }) })
    push({ t: 'page:error', tabId: TAB_ID, error: pageError('a', { message: 'second', time: 2 }) })

    expect(state().errors.value.map((e) => e.message)).toEqual(['second', 'first'])
  })

  it('错误行数超过上限：只留最近 50 条', async () => {
    await mountMonitor()
    const push = pushHandler()

    for (let i = 0; i < 51; i++) {
      push({ t: 'page:error', tabId: TAB_ID, error: pageError('a', { message: `m${i}`, time: i }) })
    }

    expect(state().errors.value).toHaveLength(50)
    expect(state().errors.value[0]?.message).toBe('m50')
    expect(state().errors.value[49]?.message).toBe('m1')
  })

  it('新文档清零：运行集与错误一并清空', async () => {
    await mountMonitor()
    const push = pushHandler()

    push({ t: 'page:runstart', tabId: TAB_ID, run: runItem('a', 'r1') })
    push({ t: 'page:error', tabId: TAB_ID, error: pageError('a') })
    expect(state().visible.value).toBe(true)

    push({ t: 'page:reset', tabId: TAB_ID })
    expect(state().runs.value).toEqual([])
    expect(state().errors.value).toEqual([])
    expect(state().visible.value).toBe(false)
  })

  it('快照：运行集按启动时间倒序，错误截到上限', async () => {
    await mountMonitor()
    const many = Array.from({ length: 55 }, (_, i) => pageError('a', { message: `m${i}`, time: i }))

    pushHandler()({
      t: 'page:snapshot',
      tabId: TAB_ID,
      runs: [runItem('a', 'r1', 100), runItem('b', 'r2', 300), runItem('c', 'r3', 200)],
      errors: many,
    })

    expect(state().runs.value.map((r) => r.uuid)).toEqual(['b', 'c', 'a'])
    expect(state().errors.value).toHaveLength(50)
  })

  it('面板可见性：有运行或有错误才占地方', async () => {
    await mountMonitor()
    const push = pushHandler()
    expect(state().visible.value).toBe(false)

    push({ t: 'page:runstart', tabId: TAB_ID, run: runItem('a', 'r1') })
    expect(state().visible.value).toBe(true)

    push({ t: 'page:reset', tabId: TAB_ID })
    expect(state().visible.value).toBe(false)

    push({ t: 'page:error', tabId: TAB_ID, error: pageError(null) })
    expect(state().visible.value).toBe(true)
  })
})

describe('展示名与错误归属', () => {
  it('展示名取名字表，未知 uuid 退化为前 8 位', async () => {
    listMock.mockResolvedValue([script('abcdefgh-1234', '改名后的脚本')])

    await mountMonitor()

    expect(state().displayName('abcdefgh-1234')).toBe('改名后的脚本')
    expect(state().displayName('zzzzzzzz-9999')).toBe('zzzzzzzz')
  })

  it('错误行按 uuid 归属：别的 uuid 与无归属的一条都不带', async () => {
    await mountMonitor()
    const push = pushHandler()

    push({ t: 'page:error', tabId: TAB_ID, error: pageError('a', { message: 'ea' }) })
    push({ t: 'page:error', tabId: TAB_ID, error: pageError('b', { message: 'eb' }) })
    push({ t: 'page:error', tabId: TAB_ID, error: pageError(null, { message: '无名' }) })

    expect(state().errorsOf('a').map((e) => e.message)).toEqual(['ea'])
    expect(state().errorsOf('c')).toEqual([])
  })

})

describe('名字补齐（自愈）', () => {
  it('挂载即拉一次名字表', async () => {
    await mountMonitor()

    expect(listMock).toHaveBeenCalledTimes(1)
  })

  it('运行集里出现名字表没有的 uuid：补拉一次', async () => {
    listMock.mockResolvedValue([])
    await mountMonitor()
    expect(listMock).toHaveBeenCalledTimes(1)

    pushHandler()({ t: 'page:runstart', tabId: TAB_ID, run: runItem('unknown-1', 'r1') })
    await flushPromises()

    expect(listMock).toHaveBeenCalledTimes(2)
  })

  it('运行集里的 uuid 名字表已经有了：不重复拉', async () => {
    listMock.mockResolvedValue([script('known-1', '已有脚本')])
    await mountMonitor()
    expect(listMock).toHaveBeenCalledTimes(1)

    pushHandler()({ t: 'page:runstart', tabId: TAB_ID, run: runItem('known-1', 'r1') })
    await flushPromises()

    expect(listMock).toHaveBeenCalledTimes(1)
  })

  it('补拉在途时的多次请求合并成一次补跑（推送风暴不打爆命令面）', async () => {
    const pending: ((v: ScriptSummary[]) => void)[] = []
    listMock.mockImplementation(
      () => new Promise<ScriptSummary[]>((resolve) => pending.push(resolve)),
    )

    await mountMonitor()
    expect(listMock).toHaveBeenCalledTimes(1) // 首拉在途，未落地

    const push = pushHandler()
    push({ t: 'page:runstart', tabId: TAB_ID, run: runItem('u1', 'r1') })
    push({ t: 'page:runstart', tabId: TAB_ID, run: runItem('u2', 'r2') })
    push({ t: 'page:runstart', tabId: TAB_ID, run: runItem('u3', 'r3') })
    expect(listMock).toHaveBeenCalledTimes(1) // 在途期间一次都没多发

    pending[0]?.([]) // 首拉收尾 → 补跑一次
    await flushPromises()
    expect(listMock).toHaveBeenCalledTimes(2)

    pending[1]?.([])
    await flushPromises()
    expect(listMock).toHaveBeenCalledTimes(2)
  })

  it('名字表拉不到：静默，展示名退化为 uuid 前缀', async () => {
    listMock.mockRejectedValue(new Error('SW 冷启动'))

    await mountMonitor()

    expect(state().displayName('abcdefgh-1')).toBe('abcdefgh')
  })

  it('脚本域数据变更触发重拉；别的域不动', async () => {
    listMock.mockResolvedValue([])
    await mountMonitor()
    expect(listMock).toHaveBeenCalledTimes(1)

    const onDataChanged = dataChangeListener()
    onDataChanged({ kind: 'data:changed', domain: 'conversation', uuid: 'c1', at: 1 })
    await flushPromises()
    expect(listMock).toHaveBeenCalledTimes(1)

    onDataChanged({ kind: 'data:changed', domain: 'script', uuid: 's1', at: 2 })
    await flushPromises()
    expect(listMock).toHaveBeenCalledTimes(2)
  })
})

describe('跟随页内导航与卸载', () => {
  it('本 tab 的地址变化就换 host', async () => {
    await mountMonitor()
    expect(state().host.value).toBe('a.test')

    tabUpdatedHandler()(TAB_ID, { url: 'https://b.test/two' }, { url: 'https://a.test/page' })

    expect(state().host.value).toBe('b.test')
  })

  it('变更信息没带地址时退回标签页当前地址', async () => {
    await mountMonitor()

    tabUpdatedHandler()(TAB_ID, {}, { url: 'https://c.test/three' })

    expect(state().host.value).toBe('c.test')
  })

  it('别的标签页导航不动本面板', async () => {
    await mountMonitor()

    tabUpdatedHandler()(9, { url: 'https://x.test/' }, {})

    expect(state().host.value).toBe('a.test')
  })

  it('卸载：摘掉导航监听并断开端口', async () => {
    const w = await mountMonitor()
    const handler = tabUpdatedHandler()

    w.unmount()
    wrappers.pop()

    expect(tabUpdatedRemove).toHaveBeenCalledWith(handler)
    expect(port.disconnect).toHaveBeenCalled()
  })
})
