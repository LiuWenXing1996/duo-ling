// UI 组件测试：PopupPanel.vue 里的「本页脚本」分区（PopupPageScripts.vue）。
//
// 这条链路的三个分支都在渲染层，故用组件测试守：
//   A. 有运行脚本 → 摘要行给计数，默认**收起**（列表不占版面），展开后列出脚本名与状态；
//   B. 无运行脚本 → 摘要行就是空态，不给可点性、不渲染列表；
//   C. 非普通网页 → 整块不渲染（与上面那条「不能显示浮层」的提示并列只会互相打架）。
//
// 边界 mock：
//   · chrome —— 手写壳，只需 tabs.query / tabs.get / tabs.onUpdated / runtime.connect。
//     假端口留一个 push 口模拟 SW 的快照应答（真 SW 不在测试里），并记录 postMessage
//     以便断言上行报文。
//   · float-panel-store（开关读写）、userscripts/ui-client（名字补齐）、use-data-sync（变更订阅）
//     —— 都与分区渲染无关，mock 掉避免牵进 IDB 与消息总线。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import PopupPanel from './PopupPanel.vue'

const listScripts = vi.hoisted(() => vi.fn())
vi.mock('@/lib/userscripts/ui-client', () => ({ userscriptClient: { list: listScripts } }))
vi.mock('@/composables/use-data-sync', () => ({ useDataSync: vi.fn() }))
vi.mock('@/lib/float-panel-store', () => ({
  getMasterEnabled: vi.fn(async () => true),
  setMasterEnabled: vi.fn(async () => undefined),
  isFloatEnabledForHost: vi.fn(async () => true),
  setHostDisabled: vi.fn(async () => undefined),
}))

/** 假端口：保留 push 口喂 SW → 面板的下行推送，并记录面板的上行 postMessage */
interface FakePort {
  postMessage: ReturnType<typeof vi.fn>
  onMessage: { addListener: (fn: (msg: unknown) => void) => void }
  onDisconnect: { addListener: (fn: () => void) => void }
  disconnect: ReturnType<typeof vi.fn>
  push: (msg: unknown) => void
}

function createFakePort(): FakePort {
  const listeners: ((msg: unknown) => void)[] = []
  return {
    postMessage: vi.fn(),
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onDisconnect: { addListener: vi.fn() },
    disconnect: vi.fn(),
    push: (msg) => {
      for (const fn of listeners) fn(msg)
    },
  }
}

/** 页面 tag 的归属答案：id 固定 7；url 传 undefined 模拟读不到地址的非普通网页 */
const TAB_ID = 7
let port: FakePort

function stubChrome(url: string | undefined): void {
  port = createFakePort()
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (p: string) => `chrome-extension://EXTID/${p}`,
      connect: vi.fn(() => port as unknown as chrome.runtime.Port),
    },
    tabs: {
      query: vi.fn(async () => [{ id: TAB_ID, url }]),
      get: vi.fn(async () => ({ id: TAB_ID, url })),
      create: vi.fn(async () => undefined),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  })
}

const wrappers: VueWrapper[] = []

/** 挂载 + 等首帧的两轮异步：PopupPanel.refresh() 与 usePageMonitor 的归属解析各一轮 */
async function mountPopup(): Promise<VueWrapper> {
  const w = mount(PopupPanel)
  wrappers.push(w)
  await flushPromises()
  await flushPromises()
  return w
}

/** 模拟 SW 回一份快照 */
async function replySnapshot(w: VueWrapper, runs: unknown[] = [], errors: unknown[] = []): Promise<void> {
  port.push({ t: 'page:snapshot', tabId: TAB_ID, runs, errors })
  await flushPromises()
}

const rows = (w: VueWrapper) => w.findAll('[data-testid="popup-page-scripts-row"]')
const toggle = (w: VueWrapper) => w.find('[data-testid="popup-page-scripts-toggle"]')

beforeEach(() => {
  listScripts.mockResolvedValue([{ uuid: 'u1', name: '示例脚本' }])
})

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers.length = 0
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('popup 的「本页脚本」分区', () => {
  it('有运行脚本：摘要行给计数，默认收起，展开后列出脚本名', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()

    // 挂载即按归属 tab 拉快照（上行报文带的是 popup 打开时的激活页）
    expect(port.postMessage).toHaveBeenCalledWith({ t: 'page:snapshot', tabId: TAB_ID })

    await replySnapshot(w, [{ uuid: 'u1', runId: 'r1', startedAt: 1 }])

    expect(toggle(w).text()).toContain('本页脚本')
    expect(toggle(w).text()).toContain('1 个在运行')
    // 默认收起：列表不占版面
    expect(rows(w)).toHaveLength(0)

    await toggle(w).trigger('click')
    await flushPromises()
    expect(rows(w)).toHaveLength(1)
    expect(rows(w)[0]!.text()).toContain('示例脚本')
    expect(rows(w)[0]!.text()).toContain('运行中')
  })

  it('无运行脚本：摘要行就是空态，不给可点性、不渲染列表', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()
    await replySnapshot(w, [])

    expect(toggle(w).text()).toContain('本页没有运行中的脚本')
    expect(toggle(w).attributes('disabled')).toBeDefined()
    expect(rows(w)).toHaveLength(0)
  })

  it('非普通网页：整块不渲染，只留「不能显示浮层」那条提示', async () => {
    // chrome:// 等页面上扩展读不到 url（manifest 无 tabs 权限），归位空
    stubChrome(undefined)
    const w = await mountPopup()

    expect(w.find('[data-testid="popup-page-scripts"]').exists()).toBe(false)
    expect(w.find('[data-testid="float-unsupported"]').exists()).toBe(true)
  })

  it('脚本出过错：行内给错误条数；摘要行给错误徽标', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()
    await replySnapshot(
      w,
      [{ uuid: 'u1', runId: 'r1', startedAt: 1 }],
      [{ uuid: 'u1', name: '示例脚本', message: 'boom', time: 2, runId: 'r1' }],
    )

    // 收起态也能看见错误计数（徽标常驻摘要行）
    expect(w.find('[data-testid="popup-page-scripts-error-count"]').text()).toBe('1')

    await toggle(w).trigger('click')
    await flushPromises()
    expect(rows(w)[0]!.text()).toContain('⚠ 1')
  })
})
