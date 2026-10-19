// UI 组件测试：PopupPanel.vue 的两个区块（PopupCurrentPage / PopupOtherPages）。
//
// 这条链路的分支都在渲染层，故用组件测试守：
//   A. 「当前页面」：两个按页开关（接口录制 / 活动记录，都常显、可就地开与关、状态随命令改口）、
//      本页在跑的脚本（头部给计数、列表常显、行只读，右侧「管理脚本」开工作台）、对话浮层入口与回话状态；
//   B. 「当前页面」浮层入口只在**拿不到网址**的页面（内部页 / 扩展页）上禁用 —— 普通网页一律让点，
//      成不成看点了之后的回执（真机上曾因探活假阴性把本来点得开的按钮禁灰）；
//   C. 「其他页面」：列出本页以外的标签页（脚本数 / 会话与生成中），点「去这里」切过去；没有别的页面给空态。
//
// 边界 mock：
//   · chrome —— 手写壳，只需 tabs.query / tabs.update / tabs.create / tabs.sendMessage
//     （「打开会话」的定向消息走这一口）+ runtime.sendMessage（命令面）。
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
vi.mock('@duoling/ui/lib/userscripts/ui-client', () => ({
  userscriptClient: { availability: availabilityQuery },
}))
// 新版本提示只读 SW 落下的结果，不在 popup 里发检查；mock 掉读侧即可完全控制它有 / 无。
// spread 保其余符号真身 —— 面板还从 shared 取 webHostname / readInjectedBuildInfo。
vi.mock('@duoling/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@duoling/shared')>()),
  readUpdateCheck,
}))

/** 页面 tag 的归属答案：id 固定 7；url 传 undefined 模拟读不到地址的非普通网页 */
const TAB_ID = 7

/** page:overview 的应答（用例按需覆盖）；默认只有当前页一行 */
let overviewRows: unknown[] = []

/** 概览里的一行（默认：无脚本、无会话、未开记录） */
function overviewRow(tabId: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tabId,
    url: 'https://example.com/page',
    title: '示例页',
    scripts: [],
    builtins: [],
    conversationId: null,
    conversationTitle: null,
    generating: false,
    tabRecording: false,
    ...over,
  }
}

/**
 * 命令面应答：总线走**回调形态**（`chrome.runtime.sendMessage(msg, cb)`，见 shared/runtime-send），
 * 故桩要把信封交给 cb；返回值也一并兑现成 resolved promise（无 cb 的写法同样能用）。
 * 断言里回调位一律写 `expect.any(Function)`。
 */
function answerCommand(cb: unknown, payload: unknown): Promise<unknown> {
  if (typeof cb === 'function') (cb as (r: unknown) => void)(payload)
  return Promise.resolve(payload)
}

/** 默认命令面：page:overview 喂 overviewRows，其余回空载荷（用例可临时覆盖单发） */
function replyCommand(msg: { kind: string }, cb?: unknown): Promise<unknown> {
  return answerCommand(
    cb,
    msg.kind === 'page:overview' ? { ok: true, data: overviewRows } : { ok: true, data: {} },
  )
}

/**
 * 装 chrome 壳。
 *
 * url 传 undefined 模拟读不到地址的页面（`chrome://` / 扩展页 —— manifest 无 tabs 权限），
 * 那类页面上站点名是空串、浮层入口禁用。浮层命令（`float:open`）默认成功，失败的那条
 * 分支由用例自己覆盖（见「页面接不上」）。
 */
function stubChrome(url: string | undefined): void {
  tabsCreate.mockResolvedValue(undefined)
  tabsSendMessage.mockResolvedValue(undefined)
  runtimeSendMessage.mockImplementation(replyCommand)
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

/** 挂载 + 等几轮异步：refresh() 里 update / 引擎可用性 / 概览三条各一轮 */
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
  const recordCard = (w: VueWrapper) => w.find('[data-testid="popup-current-tab-activity"]')
  const recordState = (w: VueWrapper) => w.find('[data-testid="popup-current-tab-activity-state"]')
  const recordToggle = (w: VueWrapper) => w.find('[data-testid="popup-toggle-tab-activity"]')

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

  it('脚本行只读：点了不上行、也不关 popup', async () => {
    stubChrome('https://example.com/page')
    overviewRows = [
      overviewRow(TAB_ID, { scripts: [{ uuid: 'u1', name: '示例脚本', errorCount: 0 }] }),
    ]
    const w = await mountPopup()
    const close = spyClose()
    const sentBefore = runtimeSendMessage.mock.calls.length

    await scriptRows(w)[0]!.trigger('click')
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 这一行只是「本页跑着哪几个脚本」的展示（错误数走行内角标），点了不该有任何跳转
    expect(runtimeSendMessage.mock.calls.length).toBe(sentBefore)
    expect(close).not.toHaveBeenCalled()
  })

  it('本页没有脚本：头部给空态文案，不渲染列表', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()

    expect(summary(w).text()).toContain('本页没有运行中的脚本')
    expect(scriptRows(w)).toHaveLength(0)
  })

  it('内置件单独成组透出：不进脚本计数，也不带「运行中」', async () => {
    stubChrome('https://example.com/page')
    overviewRows = [
      overviewRow(TAB_ID, {
        scripts: [{ uuid: 's1', name: '脚本A', errorCount: 0 }],
        builtins: [{ id: 'dl-script-relay', name: '脚本桥' }],
      }),
    ]
    const w = await mountPopup()

    // 计数只认用户脚本：内置件在，头部仍是「1 个在运行」
    expect(summary(w).text()).toContain('1 个在运行')
    const rows = w.findAll('[data-testid="popup-current-builtin-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('脚本桥')
    expect(rows[0]!.text()).toContain('内置')
    expect(rows[0]!.text()).not.toContain('运行中')
  })

  it('拿不到网址的页面（内部页 / 扩展页）：头部改说不能运行，浮层入口禁用', async () => {
    // chrome:// 与扩展页上扩展读不到 url（manifest 无 tabs 权限），那类页面上脚本也跑不了
    stubChrome(undefined)
    const w = await mountPopup()

    expect(w.find('[data-testid="popup-current-page"]').exists()).toBe(true)
    expect(summary(w).text()).toContain('当前页面不能运行脚本')
    // 浮层入口禁用的原因就地说在对话行中间（与「活动记录 / 脚本」两行对不可用状态的说法同款）
    expect(w.find('[data-testid="popup-current-float-disabled"]').text()).toBe(
      '当前页面不能显示对话浮层',
    )
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

    expect(runtimeSendMessage).toHaveBeenCalledWith(
      { kind: 'float:open', tabId: TAB_ID },
      expect.any(Function),
    )
    expect(close).toHaveBeenCalled()
  })

  it('不在回话：对话行没有状态文案（会话空闲、未绑定都不占位）', async () => {
    stubChrome('https://example.com/page')
    overviewRows = [overviewRow(TAB_ID, { conversationId: 'c1', conversationTitle: '新会话 3' })]
    expect(conversation(await mountPopup()).text()).toBe('')

    overviewRows = [overviewRow(TAB_ID)]
    expect(conversation(await mountPopup()).text()).toBe('')
  })

  it('管理脚本：点「管理脚本」新建工作台标签页（默认落脚本列表）并关窗', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()
    const close = spyClose()

    await w.find('[data-testid="open-script-manager"]').trigger('click')
    await flushPromises()

    expect(tabsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://EXTID/workbench.html',
    })
    expect(close).toHaveBeenCalled()
  })

  it('普通网页上只放着内置件：头部照常给空态，浮层入口可点', async () => {
    // 真机上出过这一档：popup 同时列着「浮层宿主（内置）」与「当前页面不能显示对话浮层」，
    // 按钮被禁灰 —— 判据来自探活的假阴性（件在册、world 配好、权限已授予，只是没答上来）。
    // 现在按钮只看「是不是普通网页」，能不能挂上看点了之后的回执。
    stubChrome('https://example.com/page')
    overviewRows = [overviewRow(TAB_ID, { builtins: [{ id: 'dl-float-host', name: '浮层宿主' }] })]
    const w = await mountPopup()

    expect(w.find('[data-testid="popup-current-builtin-row"]').text()).toContain('浮层宿主')
    expect(summary(w).text()).toContain('本页没有运行中的脚本')
    expect(w.find('[data-testid="popup-current-float-disabled"]').exists()).toBe(false)
    expect(w.find('[data-testid="open-float-panel"]').attributes('disabled')).toBeUndefined()
  })

  it('页面接不上（命令失败）：留在 popup 里说明原因，不关窗', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()
    const close = spyClose()
    // 这一发要失败：SW 推不到（该页上没有宿主件的在岗连接 —— 页面在扩展更新前就打开、
    // 或站点访问权被单独关掉）时，命令面回 { ok: false }
    runtimeSendMessage.mockImplementationOnce((msg: { kind: string }, cb?: unknown) => {
      if (msg.kind === 'float:open') return answerCommand(cb, { ok: false, error: '浮层没接上' })
      if (msg.kind === 'page:overview') return answerCommand(cb, { ok: true, data: overviewRows })
      return answerCommand(cb, { ok: true, data: {} })
    })

    await w.find('[data-testid="open-float-panel"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="open-float-error"]').exists()).toBe(true)
    // 关掉就没地方说话了
    expect(close).not.toHaveBeenCalled()
  })

  it('记录开关常显：没开也在，开关为关、状态说「未开启」', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()

    expect(recordCard(w).exists()).toBe(true)
    expect(recordState(w).text()).toContain('未开启')
    expect(recordToggle(w).attributes('aria-checked')).toBe('false')
    // 没开记录时不给「刷新页面」那句 —— 那是刚扳开开关才有的话
    expect(w.find('[data-testid="popup-recording-hint"]').exists()).toBe(false)
  })

  it('记录开着：开关为开、状态说「正在记录」，其余子卡照常', async () => {
    stubChrome('https://example.com/page')
    overviewRows = [overviewRow(TAB_ID, { tabRecording: true })]
    const w = await mountPopup()

    expect(recordState(w).text()).toContain('正在记录')
    expect(recordToggle(w).attributes('aria-checked')).toBe('true')
    // 开关卡是加在既有两张子卡之上的，不挤掉它们
    expect(scriptRows(w)).toHaveLength(0)
    expect(conversation(w).exists()).toBe(true)
  })

  it('扳开：按标签页上行开启命令，状态改口并提示接口录制要刷新页面', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()
    const close = spyClose()

    await recordToggle(w).trigger('click')
    await flushPromises()

    expect(runtimeSendMessage).toHaveBeenCalledWith(
      {
        kind: 'userscript:tabActivityEnable',
        tabId: TAB_ID,
      },
      expect.any(Function),
    )
    expect(recordState(w).text()).toContain('正在记录')
    // 接口录制那半的钩子只在文档开头挂：刚扳开还没重载，得当面说清「首屏请求没录到」
    expect(w.find('[data-testid="popup-recording-hint"]').text()).toContain('刷新页面')
    expect(close).not.toHaveBeenCalled()
  })

  it('扳回：按标签页上行关闭命令，状态回到「未开启」且不关窗', async () => {
    stubChrome('https://example.com/page')
    overviewRows = [overviewRow(TAB_ID, { tabRecording: true })]
    const w = await mountPopup()
    const close = spyClose()

    await recordToggle(w).trigger('click')
    await flushPromises()

    expect(runtimeSendMessage).toHaveBeenCalledWith(
      {
        kind: 'userscript:tabActivityDisable',
        tabId: TAB_ID,
      },
      expect.any(Function),
    )
    expect(recordState(w).text()).toContain('未开启')
    // 与「打开会话」不同：关完不关窗，popup 里还有脚本 / 会话可看
    expect(close).not.toHaveBeenCalled()
  })

  it('开关失败：状态不动并说明原因（不装成成功）', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()
    // 挂载时的那次 page:overview 已用掉默认实现，这里只覆盖接下来这一发
    runtimeSendMessage.mockImplementationOnce((_msg: unknown, cb?: unknown) =>
      answerCommand(cb, { ok: false, error: '标签页不存在' }),
    )

    await recordToggle(w).trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="popup-tab-activity-error"]').text()).toContain('标签页不存在')
    expect(recordState(w).text()).toContain('未开启')
  })

  it('不在概览里的页面（内部页 / 扩展页）：开关禁灰，状态说「当前页面不支持」', async () => {
    // 读不到 url 的页面上概览里没有这一行，也就拿不到 tabId 与站点名 —— 开关开不了
    stubChrome(undefined)
    overviewRows = []
    const w = await mountPopup()

    expect(recordCard(w).exists()).toBe(true)
    expect(recordState(w).text()).toContain('当前页面不支持')
    expect(recordToggle(w).attributes('disabled')).toBeDefined()
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

describe('popup 的标题行版本号', () => {
  it('标题旁显示当前构建版本（v 前缀）', async () => {
    // 版本来自构建期注入的 __BUILD_INFO__（vitest 环境没有该 define，须手动垫）
    vi.stubGlobal('__BUILD_INFO__', {
      dev: true,
      time: 't',
      branch: 'b',
      version: '0.10.0',
      repo: 'o/r',
    })
    stubChrome('https://example.com/page')
    const w = await mountPopup()

    expect(w.find('[data-testid="popup-version"]').text()).toBe('v0.10.0')
  })

  it('构建信息缺失：版本号不渲染（不显示成 v 空串）', async () => {
    stubChrome('https://example.com/page')
    const w = await mountPopup()

    expect(w.find('[data-testid="popup-version"]').exists()).toBe(false)
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
    expect(card.text()).toContain(
      'Chrome ≥138：在扩展详情页开启「允许运行用户脚本」开关后即可使用。',
    )

    await card.find('button').trigger('click')
    await flushPromises()
    expect(tabsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://EXTID/workbench.html#/guide',
    })
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
