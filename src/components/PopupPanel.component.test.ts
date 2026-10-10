// UI 组件测试：PopupPanel.vue 的两个区块（PopupCurrentPage / PopupOtherPages）。
//
// 这条链路的分支都在渲染层，故用组件测试守：
//   A. 「当前页面」：接口录制开关（常显，可就地开与关，状态随命令改口）、
//      本页在跑的脚本（头部给计数、列表常显、点行跳错误日志）、对话浮层入口与回话状态；
//   B. 「当前页面」注入不了内容脚本（探活无人应答）→ 头部改说原因、浮层入口禁用；
//   C. 「其他页面」：列出本页以外的标签页（脚本数 / 会话与生成中），点「去这里」切过去；没有别的页面给空态。
//
// 边界 mock：
//   · chrome —— 手写壳，只需 tabs.query / tabs.update / tabs.create / tabs.sendMessage
//     （内容脚本探活与「打开会话」的定向消息共用这一口）+ runtime.sendMessage（命令面）。
//     两块的数据全由 page:overview 一条命令喂进来（真 SW 不在测试里）。
//   · userscripts/ui-client（引擎可用性）、update-check（新版本结论）—— mock 掉，
//     避免牵进 IDB 与消息总线。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import PopupPanel from './PopupPanel.vue'

/** 引擎可用性查询（引导卡的状态源）；默认「可用」，多数用例与那张卡无关 */
const availabilityQuery = vi.hoisted(() => vi.fn())
const readUpdateCheck = vi.hoisted(() => vi.fn())
const tabsCreate = vi.hoisted(() => vi.fn())
const tabsSendMessage = vi.hoisted(() => vi.fn())
const tabsUpdate = vi.hoisted(() => vi.fn(async () => ({})))
/** 命令面（page:overview）—— 手写壳里补这一口 */
const runtimeSendMessage = vi.hoisted(() => vi.fn())
vi.mock('@/lib/userscripts/ui-client', () => ({
  userscriptClient: { availability: availabilityQuery },
}))
// 新版本提示只读 SW 落下的结果，不在 popup 里发检查；mock 掉读侧即可完全控制它有 / 无
vi.mock('@/lib/update-check', () => ({ readUpdateCheck }))

/** 页面 tag 的归属答案：id 固定 7；url 传 undefined 模拟读不到地址的非普通网页 */
const TAB_ID = 7

/** page:overview 的应答（用例按需覆盖）；默认只有当前页一行 */
let overviewRows: unknown[] = []

/** 概览里的一行（默认：无脚本、无会话、未开录制） */
function overviewRow(tabId: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tabId,
    url: 'https://example.com/page',
    title: '示例页',
    scripts: [],
    conversationId: null,
    conversationTitle: null,
    generating: false,
    netRecording: false,
    ...over,
  }
}

/**
 * 装 chrome 壳。
 *
 * `contentScriptPresent` = 内容脚本探活是否应答：popup 挂载时会向当前标签页发一条
 * `content:ping`，无人应答即「这个页面注入不了」（chrome:// 页 / 应用商店 / 站点权限设成
 * 「点击时」的站点都是这一档）。缺省应答 —— 普通网页的常态。
 */
function stubChrome(url: string | undefined, contentScriptPresent = true): void {
  tabsCreate.mockResolvedValue(undefined)
  tabsSendMessage.mockImplementation(async () =>
    contentScriptPresent ? { ok: true } : undefined,
  )
  runtimeSendMessage.mockImplementation(async (msg: { kind: string }) => {
    if (msg.kind === 'page:overview') return { ok: true, data: overviewRows }
    return { ok: true, data: {} }
  })
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'EXTID',
      getURL: (p: string) => `chrome-extension://EXTID/${p}`,
      sendMessage: runtimeSendMessage,
    },
    tabs: {
      query: vi.fn(async () => [{ id: TAB_ID, url }]),
      update: tabsUpdate,
      create: tabsCreate,
      sendMessage: tabsSendMessage,
    },
  })
}

const wrappers: VueWrapper[] = []

/** 挂载 + 等几轮异步：refresh() 里 update / 探活 / 引擎可用性 / 概览四条各一轮 */
async function mountPopup(): Promise<VueWrapper> {
  const w = mount(PopupPanel)
  wrappers.push(w)
  await flushPromises()
  await flushPromises()
  await flushPromises()
  return w
}

/** 假的 window.close：真关窗在 happy-dom 里没有可观测效果，换 spy 才能断言「关没关」 */
function spyClose(): ReturnType<typeof vi.fn> {
  const close = vi.fn()
  vi.stubGlobal('close', close)
  return close
}

beforeEach(() => {
  overviewRows = [overviewRow(TAB_ID)]
  availabilityQuery.mockResolvedValue({
    available: true,
    isFirefox: false,
    chromeMajor: 140,
    guideText: '',
  })
})

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers.length = 0
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('popup 的「当前页面」区块', () => {
  const summary = (w: VueWrapper) => w.find('[data-testid="popup-current-scripts-summary"]')
  const scriptRows = (w: VueWrapper) => w.findAll('[data-testid="popup-current-scripts-row"]')
  const conversation = (w: VueWrapper) => w.find('[data-testid="popup-current-conversation"]')
  const recordingCard = (w: VueWrapper) => w.find('[data-testid="popup-current-recording"]')
  const recordingState = (w: VueWrapper) => w.find('[data-testid="popup-current-recording-state"]')
  const recordingToggle = (w: VueWrapper) => w.find('[data-testid="popup-toggle-recording"]')

  it('头部给站点名；本页在跑脚本：头部给计数，列表直接列出（不折叠）', async () => {
    stubChrome('https://example.com/page')
    overviewRows = [
      overviewRow(TAB_ID, { scripts: [{ uuid: 'u1', name: '示例脚本', errorCount: 0 }] }),
    ]
    const w = await mountPopup()

    expect(w.find('[data-testid="popup-current-host"]').text()).toBe('example.com')
    expect(summary(w).text()).toContain('1 个在运行')
    // 不折叠：打开即见列表（脚本多时列表自己滚，卡高不涨）
    expect(scriptRows(w)).toHaveLength(1)
    expect(scriptRows(w)[0]!.text()).toContain('示例脚本')
    expect(scriptRows(w)[0]!.text()).toContain('运行中')
  })

  it('脚本出过错：头部给错误条数，行内也标出条数', async () => {
    stubChrome('https://example.com/page')
    overviewRows = [
      overviewRow(TAB_ID, { scripts: [{ uuid: 'u1', name: '示例脚本', errorCount: 2 }] }),
    ]
    const w = await mountPopup()

    expect(w.find('[data-testid="popup-current-scripts-error-count"]').text()).toBe('2')
    expect(scriptRows(w)[0]!.text()).toContain('⚠ 2')
  })

  it('点脚本行：上行 page:openErrors 并关掉 popup', async () => {
    stubChrome('https://example.com/page')
    overviewRows = [
      overviewRow(TAB_ID, { scripts: [{ uuid: 'u1', name: '示例脚本', errorCount: 0 }] }),
    ]
    const w = await mountPopup()
    const close = spyClose()

    await scriptRows(w)[0]!.trigger('click')
    await flushPromises()
    // 关闭延后一帧（上行是异步投递，同一 tick 里关掉文档会让它悬空）——让那个定时器跑完
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtimeSendMessage).toHaveBeenCalledWith({ kind: 'page:openErrors', uuid: 'u1' })
    expect(close).toHaveBeenCalled()
  })

  it('本页没有脚本：头部给空态文案，不渲染列表', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()

    expect(summary(w).text()).toContain('本页没有运行中的脚本')
    expect(scriptRows(w)).toHaveLength(0)
  })

  it('注入不了内容脚本（探活无人应答）：头部改说不能运行', async () => {
    // chrome:// 等页面上扩展读不到 url（manifest 无 tabs 权限），内容脚本也没注入
    stubChrome(undefined, false)
    const w = await mountPopup()

    expect(w.find('[data-testid="popup-current-page"]').exists()).toBe(true)
    expect(summary(w).text()).toContain('当前页面不能运行脚本')
    // 浮层那枚按钮的原因挂在悬停提示上（tooltip 悬停才挂载，不进组件树），正文里没有那条独立说明
    expect(w.text()).not.toContain('当前页面不能显示浮层')
  })

  it('回话中：对话行只报「AI 正在回话」，浮层入口点开即唤起当前页浮层', async () => {
    stubChrome('https://example.com/page')
    overviewRows = [
      overviewRow(TAB_ID, {
        conversationId: 'c1',
        conversationTitle: '新会话 3',
        generating: true,
      }),
    ]
    const w = await mountPopup()
    const close = spyClose()

    expect(conversation(w).text()).toContain('AI 正在回话')
    // 标题不进这一行（那是浮层与工作台的事）
    expect(conversation(w).text()).not.toContain('新会话 3')
    await w.find('[data-testid="open-float-panel"]').trigger('click')
    await flushPromises()

    expect(tabsSendMessage).toHaveBeenCalledWith(TAB_ID, { kind: 'float:open' })
    expect(close).toHaveBeenCalled()
  })

  it('不在回话：对话行没有状态文案（会话空闲、未绑定都不占位）', async () => {
    stubChrome('https://example.com/page')
    overviewRows = [overviewRow(TAB_ID, { conversationId: 'c1', conversationTitle: '新会话 3' })]
    expect(conversation(await mountPopup()).text()).toBe('')

    overviewRows = [overviewRow(TAB_ID)]
    expect(conversation(await mountPopup()).text()).toBe('')
  })

  it('注入不了内容脚本：浮层入口禁用（探活无人应答的页面都算）', async () => {
    stubChrome(undefined, false)
    const w = await mountPopup()
    expect(w.find('[data-testid="open-float-panel"]').attributes('disabled')).toBeDefined()
  })

  it('页面接不上（消息发不出去）：留在 popup 里说明原因，不关窗', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()
    const close = spyClose()
    // 必须在挂载之后再埋：挂载时 popup 会向当前标签页发一条 content:ping 探活，走的是同一个
    // tabs.sendMessage —— 提前埋会被探活先吃掉，等点按钮时这一发就正常返回、失败分支不触发。
    tabsSendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist'))

    await w.find('[data-testid="open-float-panel"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="open-float-error"]').exists()).toBe(true)
    // 关掉就没地方说话了
    expect(close).not.toHaveBeenCalled()
  })

  it('录制卡常显：没在录也在，开关为关、状态说「未开启」', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()

    expect(recordingCard(w).exists()).toBe(true)
    expect(recordingState(w).text()).toContain('未开启')
    expect(recordingToggle(w).attributes('aria-checked')).toBe('false')
    // 没开录制时不给「刷新页面」那句 —— 那是刚扳开开关才有的话
    expect(w.find('[data-testid="popup-recording-hint"]').exists()).toBe(false)
  })

  it('正在录制：开关为开、状态说「正在录制」，其余子卡照常', async () => {
    stubChrome('https://example.com/page')
    overviewRows = [overviewRow(TAB_ID, { netRecording: true })]
    const w = await mountPopup()

    expect(recordingState(w).text()).toContain('正在录制')
    expect(recordingToggle(w).attributes('aria-checked')).toBe('true')
    // 录制卡是加在既有两张子卡之上的，不挤掉它们
    expect(scriptRows(w)).toHaveLength(0)
    expect(conversation(w).exists()).toBe(true)
  })

  it('扳开开关：按标签页上行开启命令，成功后状态改口并提示刷新页面', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()
    const close = spyClose()

    await recordingToggle(w).trigger('click')
    await flushPromises()

    expect(runtimeSendMessage).toHaveBeenCalledWith({
      kind: 'userscript:netCaptureEnable',
      tabId: TAB_ID,
      host: 'example.com',
    })
    expect(recordingState(w).text()).toContain('正在录制')
    // 钩子只在文档开头挂：刚扳开还没重载，得当面说清「还没在录」
    expect(w.find('[data-testid="popup-recording-hint"]').text()).toContain('刷新页面')
    expect(close).not.toHaveBeenCalled()
  })

  it('扳回开关：按标签页上行关闭命令，状态回到「未开启」且不关窗', async () => {
    stubChrome('https://example.com/page')
    overviewRows = [overviewRow(TAB_ID, { netRecording: true })]
    const w = await mountPopup()
    const close = spyClose()

    await recordingToggle(w).trigger('click')
    await flushPromises()

    expect(runtimeSendMessage).toHaveBeenCalledWith({
      kind: 'userscript:netCaptureDisable',
      tabId: TAB_ID,
    })
    expect(recordingState(w).text()).toContain('未开启')
    // 与「打开会话」不同：关完不关窗，popup 里还有脚本 / 会话可看
    expect(close).not.toHaveBeenCalled()
  })

  it('开关失败：状态不动并说明原因（不装成成功）', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()
    // 挂载时的那次 page:overview 已用掉默认实现，这里只覆盖接下来这一发
    runtimeSendMessage.mockImplementationOnce(async () => ({ ok: false, error: '无效的站点' }))

    await recordingToggle(w).trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="popup-recording-error"]').text()).toContain('无效的站点')
    expect(recordingState(w).text()).toContain('未开启')
  })

  it('不在概览里的页面（内部页 / 扩展页）：开关禁灰，状态说「当前页面不支持」', async () => {
    // 读不到 url 的页面上概览里没有这一行，也就拿不到 tabId 与站点名 —— 开不了录制
    stubChrome(undefined, false)
    overviewRows = []
    const w = await mountPopup()

    expect(recordingCard(w).exists()).toBe(true)
    expect(recordingState(w).text()).toContain('当前页面不支持')
    expect(recordingToggle(w).attributes('disabled')).toBeDefined()
  })
})

describe('popup 的「其他页面」区块', () => {
  const otherRows = (w: VueWrapper) => w.findAll('[data-testid="popup-other-page-row"]')

  it('列出本页以外的页面：第 1 行给站点名，第 2 行给脚本数与会话状态', async () => {
    stubChrome('https://example.com/page')
    overviewRows = [
      overviewRow(TAB_ID),
      overviewRow(8, {
        url: 'https://b.com/x',
        title: 'B 页',
        scripts: [{ uuid: 'u2', name: '脚本乙', errorCount: 0 }],
        conversationId: 'c2',
        conversationTitle: '新会话 2',
        generating: true,
      }),
      // 什么活动都没有的页面也列（列表口径 = 所有打开的页面），第二行退化为页面标题
      overviewRow(9, { url: 'https://c.com/', title: 'C 页' }),
    ]
    const w = await mountPopup()

    expect(otherRows(w)).toHaveLength(2)
    const first = otherRows(w)[0]!.text()
    expect(first).toContain('b.com')
    expect(first).toContain('1 个脚本')
    expect(first).toContain('正在生成「新会话 2」')
    expect(otherRows(w)[1]!.text()).toContain('c.com')
    expect(otherRows(w)[1]!.text()).toContain('C 页')
  })

  it('内容区不可点：点它不切换（切换只归「去这里」按钮）', async () => {
    stubChrome('https://example.com/page')
    overviewRows = [overviewRow(TAB_ID), overviewRow(8, { url: 'https://b.com/x' })]
    const w = await mountPopup()
    const close = spyClose()

    await otherRows(w)[0]!.trigger('click')
    await flushPromises()

    expect(tabsUpdate).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('「去这里」按钮：点了切过去并关窗', async () => {
    stubChrome('https://example.com/page')
    overviewRows = [overviewRow(TAB_ID), overviewRow(8, { url: 'https://b.com/x' })]
    const w = await mountPopup()
    const close = spyClose()

    await w.find('[data-testid="popup-other-page-go"]').trigger('click')
    await flushPromises()

    expect(tabsUpdate).toHaveBeenCalledWith(8, { active: true })
    expect(close).toHaveBeenCalled()
  })

  it('只有当前页：给空态', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()

    expect(otherRows(w)).toHaveLength(0)
    expect(w.find('[data-testid="popup-other-pages-empty"]').text()).toContain('没有其他打开的页面')
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
    const close = spyClose()
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
