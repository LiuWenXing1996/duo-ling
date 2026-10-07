// UI 组件测试：PopupPanel.vue 里的「本页脚本」分区（PopupPageScripts.vue）。
//
// 这条链路的三个分支都在渲染层，故用组件测试守：
//   A. 有运行脚本 → 摘要行给计数，默认**收起**（列表不占版面），展开后列出脚本名与状态；
//   B. 无运行脚本 → 摘要行就是空态，不给可点性、不渲染列表；
//   C. 注入不了内容脚本的页面（探活无人应答）→ 卡片照常渲染，摘要行改说不能运行、不给可点性。
//
// 边界 mock：
//   · chrome —— 手写壳，只需 tabs.query / tabs.get / tabs.onUpdated / tabs.sendMessage
//     （内容脚本探活与「打开会话」的定向消息共用这一口）/ runtime.connect。
//     假端口留一个 push 口模拟 SW 的快照应答（真 SW 不在测试里），并记录 postMessage
//     以便断言上行报文。
//   · userscripts/ui-client（名字补齐）、use-data-sync（变更订阅）—— 都与分区渲染无关，
//     mock 掉避免牵进 IDB 与消息总线。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import PopupPanel from './PopupPanel.vue'

const listScripts = vi.hoisted(() => vi.fn())
/** 引擎可用性查询（引导卡的状态源）；默认「可用」，多数用例与那张卡无关 */
const availabilityQuery = vi.hoisted(() => vi.fn())
const readUpdateCheck = vi.hoisted(() => vi.fn())
const tabsCreate = vi.hoisted(() => vi.fn())
const tabsSendMessage = vi.hoisted(() => vi.fn())
const tabsUpdate = vi.hoisted(() => vi.fn(async () => ({})))
/** 通知区（PopupNotifications）经 runtime.sendMessage 问 SW —— 手写壳里补这一口 */
const runtimeSendMessage = vi.hoisted(() => vi.fn())
vi.mock('@/lib/userscripts/ui-client', () => ({
  userscriptClient: { list: listScripts, availability: availabilityQuery },
}))
vi.mock('@/composables/use-data-sync', () => ({ useDataSync: vi.fn() }))
// 新版本提示只读 SW 落下的结果，不在 popup 里发检查；mock 掉读侧即可完全控制它有 / 无
vi.mock('@/lib/update-check', () => ({ readUpdateCheck }))

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

/**
 * 装 chrome 壳。
 *
 * `contentScriptPresent` = 内容脚本探活是否应答：popup 挂载时会向当前标签页发一条
 * `content:ping`，无人应答即「这个页面注入不了」（chrome:// 页 / 应用商店 / 站点权限设成
 * 「点击时」的站点都是这一档）。缺省应答 —— 普通网页的常态。
 */
function stubChrome(url: string | undefined, contentScriptPresent = true): void {
  port = createFakePort()
  tabsCreate.mockResolvedValue(undefined)
  tabsSendMessage.mockImplementation(async () =>
    contentScriptPresent ? { ok: true } : undefined,
  )
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
  // 引擎可用性的默认答案：可用（引导卡不渲染；要测那张卡的用例自己覆写）
  availabilityQuery.mockResolvedValue({ available: true, isFirefox: false, chromeMajor: 140, guideText: '' })
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

  it('注入不了内容脚本（探活无人应答）：卡片照常渲染，摘要行改说不能运行、不给可点性', async () => {
    // chrome:// 等页面上扩展读不到 url（manifest 无 tabs 权限），内容脚本也没注入
    stubChrome(undefined, false)
    const w = await mountPopup()

    expect(w.find('[data-testid="popup-page-scripts"]').exists()).toBe(true)
    expect(toggle(w).text()).toContain('当前页面不能运行脚本')
    expect(toggle(w).attributes('disabled')).toBeDefined()
    expect(rows(w)).toHaveLength(0)
    // 浮层那枚按钮的原因挂在悬停提示上（tooltip 悬停才挂载，不进组件树），正文里没有那条独立说明
    expect(w.text()).not.toContain('当前页面不能显示浮层')
  })

  it('scheme 上是普通网页、探活却无人应答（应用商店 / 站点权限设成「点击时」）：也说不能运行', async () => {
    // url 判不出这一类 —— 拦注入的是 Chrome 注入策略 / 站点授权，只有探活认得出来
    stubChrome('https://chromewebstore.google.com/detail/x', false)
    const w = await mountPopup()

    expect(toggle(w).text()).toContain('当前页面不能运行脚本')
    expect(toggle(w).attributes('disabled')).toBeDefined()
  })

  it('scheme 说不是普通网页、探活却应答（本地文件页开了文件访问）：照常给空态', async () => {
    stubChrome('file:///tmp/demo.html')
    const w = await mountPopup()
    await replySnapshot(w, [])

    expect(toggle(w).text()).toContain('本页没有运行中的脚本')
  })

  it('探活无人应答却仍有运行记录：以记录为准，不误报不能运行', async () => {
    // 探活答的是「此刻」，可能滞后于登记表（页面刚导航、内容脚本还没跑起来时探活说不在）
    stubChrome('https://example.com/page', false)
    const w = await mountPopup()
    await replySnapshot(w, [{ uuid: 'u1', runId: 'r1', startedAt: 1 }])

    expect(toggle(w).text()).toContain('1 个在运行')

    await toggle(w).trigger('click')
    await flushPromises()
    expect(rows(w)).toHaveLength(1)
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

describe('popup 的工作台入口', () => {
  it('点了新建 workbench 标签页，不带 hash（落默认面板）', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()

    await w.find('[data-testid="open-workbench"]').trigger('click')
    await flushPromises()
    expect(tabsCreate).toHaveBeenCalledWith({ url: 'chrome-extension://EXTID/workbench.html' })
  })
})

// 「打开会话」入口：对话框平时不在页面里（content script 默认不往页面放 DOM），这里是它的常规
// 打开方式。这条链路的关键在「定向消息发给谁」与「失败时说得出话」。
describe('popup 的「打开会话」入口', () => {
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

  it('注入不了内容脚本：按钮不可用（探活无人应答的页面都算）', async () => {
    stubChrome(undefined, false)
    expect(openBtn(await mountPopup()).attributes('disabled')).toBeDefined()
  })

  it('scheme 上是普通网页、探活却无人应答（应用商店 / 站点权限设成「点击时」）：同样不可用', async () => {
    stubChrome('https://chromewebstore.google.com/detail/x', false)
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

// 引导卡：引擎开关没开时，popup 得给一句现状 + 一个去「引导」页的入口（角标亮着 `!`，
// 用户顺着点进来不能没有落脚处）。三个分支：没开 → 出卡；可用 → 不渲染；查询失败 → 不渲染
// （宁可不提示，也不能把异常渲染成「你的开关没开」）。
describe('popup 的引擎不可用引导卡', () => {
  const box = (w: VueWrapper) => w.find('[data-testid="userscript-unavailable"]')

  it('开关没开：出卡给引导文案，按钮深链到工作台「引导」页并关掉 popup', async () => {
    stubChrome('https://example.com/page')
    availabilityQuery.mockResolvedValue({
      available: false,
      isFirefox: false,
      chromeMajor: 140,
      guideText: 'Chrome ≥138：在扩展详情页开启「允许运行用户脚本」开关后即可使用。',
    })
    const close = vi.fn()
    vi.stubGlobal('close', close)
    const w = await mountPopup()

    const card = box(w)
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('用户脚本功能不可用')
    // 文案原样透传：版本分支是 engine 拼的，这里只负责展示，不复制分支逻辑
    expect(card.text()).toContain('Chrome ≥138：在扩展详情页开启「允许运行用户脚本」开关后即可使用。')

    await card.find('button').trigger('click')
    await flushPromises()
    expect(tabsCreate).toHaveBeenCalledWith({ url: 'chrome-extension://EXTID/workbench.html#/guide' })
    expect(close).toHaveBeenCalled()
  })

  it('可用：整卡不渲染', async () => {
    stubChrome('https://example.com/page')
    expect(box(await mountPopup()).exists()).toBe(false)
  })

  it('查询失败：整卡不渲染（异常不当「没开」）', async () => {
    stubChrome('https://example.com/page')
    availabilityQuery.mockRejectedValue(new Error('扩展服务未响应，请重试'))
    expect(box(await mountPopup()).exists()).toBe(false)
  })
})

// 通知区：角标只报脚本运行数（会话的事它一个字都不提），明细落在这里。四个分支都要守 ——
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
    const w = await mountPopup()
    // 必须在挂载之后再埋：挂载时 popup 会向当前标签页发一条 content:ping 探活，走的是同一个
    // tabs.sendMessage —— 提前埋会被探活先吃掉，等点通知时这一发就正常返回、兜底分支不触发。
    tabsSendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist'))

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
