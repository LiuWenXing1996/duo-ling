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
import { ensureFloatEnabled } from '@/lib/float-panel-store'

const listScripts = vi.hoisted(() => vi.fn())
const readUpdateCheck = vi.hoisted(() => vi.fn())
const tabsCreate = vi.hoisted(() => vi.fn())
const tabsSendMessage = vi.hoisted(() => vi.fn())
const tabsUpdate = vi.hoisted(() => vi.fn(async () => ({})))
/** 通知区（PopupNotifications）经 runtime.sendMessage 问 SW —— 手写壳里补这一口 */
const runtimeSendMessage = vi.hoisted(() => vi.fn())
vi.mock('@/lib/userscripts/ui-client', () => ({ userscriptClient: { list: listScripts } }))
vi.mock('@/composables/use-data-sync', () => ({ useDataSync: vi.fn() }))
// 新版本提示只读 SW 落下的结果，不在 popup 里发检查；mock 掉读侧即可完全控制它有 / 无
vi.mock('@/lib/update-check', () => ({ readUpdateCheck }))
vi.mock('@/lib/float-panel-store', () => ({
  getMasterEnabled: vi.fn(async () => true),
  setMasterEnabled: vi.fn(async () => undefined),
  isFloatEnabledForHost: vi.fn(async () => true),
  setHostDisabled: vi.fn(async () => undefined),
  ensureFloatEnabled: vi.fn(async () => undefined),
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
  tabsCreate.mockResolvedValue(undefined)
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'EXTID',
      getURL: (p: string) => `chrome-extension://EXTID/${p}`,
      connect: vi.fn(() => port as unknown as chrome.runtime.Port),
      sendMessage: runtimeSendMessage,
    },
    tabs: {
      query: vi.fn(async () => [{ id: TAB_ID, url }]),
      get: vi.fn(async () => ({ id: TAB_ID, url })),
      update: tabsUpdate,
      create: tabsCreate,
      sendMessage: tabsSendMessage,
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
  // 通知区的默认答案：一条通知都没有（多数用例与它无关，给个空快照免得噪声）
  runtimeSendMessage.mockResolvedValue({ ok: true, data: { running: [], items: [] } })
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

describe('popup 的扩展管理页入口', () => {
  it('点了打开 chrome://extensions，URL 带本扩展 id', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()

    await w.find('[data-testid="open-extensions-page"]').trigger('click')
    await flushPromises()
    expect(tabsCreate).toHaveBeenCalledWith({ url: 'chrome://extensions/?id=EXTID' })
  })
})

// 页面外的浮层入口：悬浮按钮被页面元素挡住、或当前站点没显示浮层时，用户在页面上什么都点不到，
// 只能从 popup 把浮层叫出来。这条链路的关键在「谁能收到消息」与「失败时说得出话」。
describe('popup 的「对话浮层」入口', () => {
  const openBtn = (w: VueWrapper) => w.find('[data-testid="open-float-panel"]')

  /** 假的 window.close：真关窗在 happy-dom 里没有可观测效果，换 spy 才能断言「关没关」 */
  function spyClose(): ReturnType<typeof vi.fn> {
    const close = vi.fn()
    vi.stubGlobal('close', close)
    return close
  }

  it('点开：向当前标签页发定向消息，成功后关掉 popup', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()
    const close = spyClose()

    await openBtn(w).trigger('click')
    await flushPromises()

    // tabId 是 popup 打开时的激活页 —— 内容脚本按它认自己属于哪个标签页
    expect(tabsSendMessage).toHaveBeenCalledWith(TAB_ID, { kind: 'float:open' })
    expect(close).toHaveBeenCalled()
  })

  it('发消息前先把开关补齐（补齐策略在 ensureFloatEnabled 一处，页面右键菜单共用）', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()

    await openBtn(w).trigger('click')
    await flushPromises()

    // 不补齐的话会出现「浮层显示着、开关却写着已关」，用户下次刷新页面浮层消失无从解释。
    // 「补齐成什么样」由 ensureFloatEnabled 决定，见 lib/float-panel-store 的单测。
    expect(ensureFloatEnabled).toHaveBeenCalledWith('example.com')
    expect(tabsSendMessage).toHaveBeenCalledWith(TAB_ID, { kind: 'float:open' })
  })

  it('页面接不上（消息发不出去）：留在 popup 里说明原因，不关窗', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()
    const close = spyClose()
    tabsSendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist'))

    await openBtn(w).trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="open-float-error"]').exists()).toBe(true)
    // 关掉就没地方说话了
    expect(close).not.toHaveBeenCalled()
  })

  it('非普通网页：按钮不可用（这些页面上内容脚本注入不了）', async () => {
    stubChrome(undefined)
    expect(openBtn(await mountPopup()).attributes('disabled')).toBeDefined()
  })
})

describe('popup 的新版本提示', () => {
  const box = (w: VueWrapper) => w.find('[data-testid="update-available"]')

  it('没查过：整块不出现', async () => {
    stubChrome('https://example.com/page')
    readUpdateCheck.mockResolvedValue(undefined)
    expect(box(await mountPopup()).exists()).toBe(false)
  })

  it('已是最新：整块不出现', async () => {
    stubChrome('https://example.com/page')
    readUpdateCheck.mockResolvedValue({
      checkedAt: 1,
      current: '0.2.0-alpha.1',
      status: { kind: 'current', latest: '0.2.0-alpha.1' },
    })
    expect(box(await mountPopup()).exists()).toBe(false)
  })

  it('上次没查成：整块不出现（离线不该在 popup 上变成一条错误）', async () => {
    stubChrome('https://example.com/page')
    readUpdateCheck.mockResolvedValue({
      checkedAt: 1,
      current: '0.2.0-alpha.1',
      status: { kind: 'unavailable', reason: 'GitHub 返回 403' },
    })
    expect(box(await mountPopup()).exists()).toBe(false)
  })

  it('有新版本：给出最新与当前版本号，按钮跳 Release 页面', async () => {
    stubChrome('https://example.com/page')
    readUpdateCheck.mockResolvedValue({
      checkedAt: 1,
      current: '0.2.0-alpha.1',
      status: { kind: 'update', latest: '0.3.0', releaseUrl: 'https://example.com/r' },
    })
    const w = await mountPopup()

    const card = box(w)
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('v0.3.0')
    expect(card.text()).toContain('v0.2.0-alpha.1')

    await card.find('button').trigger('click')
    await flushPromises()
    expect(tabsCreate).toHaveBeenCalledWith({ url: 'https://example.com/r' })
  })
})

// 通知区：角标只有一个数字（说不清是什么事），明细落在这里。四个分支都要守 ——
// 没通知不渲染（常态 popup 保持原样）、有内容成形、点条目跳过去并标已读、全部已读清空。
describe('popup 的通知区', () => {
  const box = (w: VueWrapper) => w.find('[data-testid="popup-notifications"]')
  const items = (w: VueWrapper) => w.findAll('[data-testid="notify-item"]')

  /** 构造一份 notify:list 的应答 */
  const snapshot = (over: { running?: unknown[]; items?: unknown[] } = {}) => ({
    ok: true as const,
    data: { running: over.running ?? [], items: over.items ?? [] },
  })

  const UNREAD = {
    id: 'n1',
    kind: 'chat-done',
    conversationId: 'c1',
    tabId: 8,
    host: 'b.com',
    createdAt: Date.now(),
  }

  it('没有通知：整块不渲染', async () => {
    stubChrome('https://example.com/page')
    expect(box(await mountPopup()).exists()).toBe(false)
  })

  it('进行中与未读分别成行，各自带上站点名', async () => {
    stubChrome('https://example.com/page')
    runtimeSendMessage.mockResolvedValue(
      snapshot({
        running: [{ conversationId: 'c-run', host: 'a.com', tabId: 7, startedAt: 1 }],
        items: [UNREAD],
      }),
    )
    const w = await mountPopup()

    expect(box(w).exists()).toBe(true)
    const runningRow = w.find('[data-testid="notify-running"]')
    expect(runningRow.text()).toContain('正在生成')
    expect(runningRow.text()).toContain('a.com')
    expect(items(w)).toHaveLength(1)
    expect(items(w)[0]!.text()).toContain('对话已完成')
    expect(items(w)[0]!.text()).toContain('b.com')
  })

  it('点未读那条：先标已读，再唤起那个标签页的浮层', async () => {
    stubChrome('https://example.com/page')
    runtimeSendMessage.mockResolvedValue(snapshot({ items: [UNREAD] }))
    const close = vi.fn()
    vi.stubGlobal('close', close)
    const w = await mountPopup()

    await items(w)[0]!.trigger('click')
    await flushPromises()

    expect(runtimeSendMessage).toHaveBeenCalledWith({ kind: 'notify:read', id: 'n1' })
    // 那个标签页还开着 → 翻到前台并把浮层叫出来（用户就是去看那条结果）
    expect(tabsUpdate).toHaveBeenCalledWith(8, { active: true })
    expect(tabsSendMessage).toHaveBeenCalledWith(8, { kind: 'float:open' })
    expect(close).toHaveBeenCalled()
  })

  it('标签页已关：落到工作台会话历史，不让这一下点击石沉大海', async () => {
    stubChrome('https://example.com/page')
    runtimeSendMessage.mockResolvedValue(snapshot({ items: [UNREAD] }))
    vi.stubGlobal('close', vi.fn())
    tabsSendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist'))
    const w = await mountPopup()

    await items(w)[0]!.trigger('click')
    await flushPromises()

    expect(tabsCreate).toHaveBeenCalledWith({ url: 'chrome-extension://EXTID/workbench.html#/sessions' })
  })

  it('「全部已读」：上行 readAll，读回后未读行消失', async () => {
    stubChrome('https://example.com/page')
    let readAll = false
    runtimeSendMessage.mockImplementation(async (msg: { kind: string }) => {
      if (msg.kind === 'notify:readAll') {
        readAll = true
        return { ok: true, data: { unread: 0 } }
      }
      return readAll ? snapshot() : snapshot({ items: [UNREAD] })
    })
    const w = await mountPopup()
    expect(items(w)).toHaveLength(1)

    await w.find('[data-testid="notify-read-all"]').trigger('click')
    await flushPromises()

    expect(runtimeSendMessage).toHaveBeenCalledWith({ kind: 'notify:readAll' })
    expect(items(w)).toHaveLength(0)
  })
})
