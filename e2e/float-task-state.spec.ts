// 会话状态外显的端测：**角标不参与**（它只报「这个标签页在跑几个脚本」，见 action-badge.spec.ts），
// 会话这边的落点只有一处 —— SW 内存里的「进行中」登记表（工作台「会话历史」的「生成中」标与
// 停止入口靠它，见 use-chat-running）。
//
// 于是本 spec 收窄成两件事：
//   1. 会话状态与角标无关：在跑 / 跑完都不点亮角标（防回归 —— 这条曾经是角标的全部职责）；
//   2. 进行中登记的进出：任务开跑就登记、收尾就撤下、关标签页要中止并撤下。
//
// 第 1 条的判据是「角标里不出现脚本计数」而非「角标为空」：角标只报脚本运行数，而本 spec 一个用户
// 脚本都没装 —— 引擎开了是空串，引擎引导失败是**全局** `!`（见 action-badge.spec.ts 的未授权那组）。
//
// 另有一条守「对话框的显隐」：页面里平时不建任何 DOM，收到 float:open 才挂出来，收起只把容器
// 藏起来（iframe 与面板文档留在原位，再打开就是原状态）—— 该条要探活浮层宿主，暂时跳过（原因见用例上的注释）。
//
// ⚠️ 本 spec 必须**引导 userScripts 引擎**：宿主件（`dl-float-host`）是注册用户脚本，引擎没开时
// 页面里根本没有它、`float:open` 无人接（声明式内容脚本那条路才不受引擎开关影响）。
//
// 页面内没有可点的入口（对话框平时不在页面里），故打开 / 收起一律走那两条定向消息 ——
// 与 popup 的按钮、页面右键菜单、对话框顶栏那颗「收起」是同一套契约（发送方那侧的行为由
// PopupPanel 的组件测试覆盖）。无头下也没有「在 iframe 里发消息」那条路，见 smoke.spec.ts
// 头注释。
//
// 推假会话的几条不需要真会话存在：SW 只登记会话 id（站点名 / 标签页都不再拼给它），故不必代写归属。
import { test, expect, type BrowserContext, type Frame, type Page, type Worker } from '@playwright/test'
import * as http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkUserScriptsAvailable,
  enableUserScripts,
  extensionIdFromServiceWorker,
  getServiceWorker,
  launchExtensionContext,
  openMessengerPage,
} from './extension'
import { startModelStub } from '../scripts/model-stub.mjs'

test.describe.serial('任务状态外显（进行中登记 + 对话框显隐）', () => {
  let context: BrowserContext | undefined
  let sw: Worker
  let messenger: Page
  let profileDir = ''
  let probe: http.Server | undefined
  let probeUrl = ''
  /** 引擎是否真的可用（引导失败时对话框那一条转手测，其余用例不受影响，见文件头） */
  let engineAvailable = false

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-taskstate-e2e-'))

    await bootstrapEngine(profileDir)
    context = await launchExtensionContext(profileDir)
    sw = await getServiceWorker(context)
    messenger = await openMessengerPage(context, extensionIdFromServiceWorker(sw))
    engineAvailable = await checkUserScriptsAvailable(sw)

    // 本地探针页：走 http(s) —— file:// 要另开「允许访问文件网址」才注入得了（与 smoke 同做法）
    probe = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body><h1>probe</h1></body></html>')
    })
    await new Promise<void>((resolve) => probe!.listen(0, '127.0.0.1', () => resolve()))
    const addr = probe.address()
    if (!addr || typeof addr === 'string') throw new Error('探针页地址取不到')
    probeUrl = `http://127.0.0.1:${addr.port}/`
  })

  test.afterAll(async () => {
    const withTimeout = (p: Promise<unknown> | undefined, ms: number) =>
      p ? Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve()
    try { await withTimeout(context?.close(), 30_000) } catch { /* 忽略 */ }
    try {
      probe?.closeAllConnections()
      await withTimeout(new Promise<void>((r) => probe?.close(() => r())), 5_000)
    } catch { /* 忽略 */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })

  /**
   * 从扩展页推一条 offscreen 推送（chat:running / chat:finished）。
   * 不能从 SW 自发：runtime 消息不回环到发送者自身上下文（见 extension.ts 的说明）。
   * 没有接收方响应这条消息（SW 只旁听、不 sendResponse），故吞掉可能的 reject。
   */
  const pushOffscreen = (msg: Record<string, unknown>): Promise<unknown> =>
    messenger.evaluate((m) => {
      void chrome.runtime.sendMessage(m).catch(() => {})
    }, msg)

  test('会话状态不进角标（角标只报脚本运行数）；进行中登记随收尾撤下', async () => {
    const c1 = 'e2e-count-1'
    const c2 = 'e2e-count-2'

    // 两页都用 http 探针页，**不要拿扩展自己的 popup 页来反查 tabId**：manifest 没有 `tabs`
    // 权限，而 `<all_urls>` 不覆盖 `chrome-extension://` —— 扩展自身页面的 `url` 在 SW 里根本
    // 读不到，按 URL 反查必然落空（踩过）。
    const otherUrl = `${probeUrl}other`
    const page = await context!.newPage()
    await page.goto(probeUrl)
    const otherPage = await context!.newPage()
    await otherPage.goto(otherUrl)
    const [probeTabId] = await tabIdsOf(sw, probeUrl)
    const [otherTabId] = await tabIdsOf(sw, otherUrl)
    expect(probeTabId, '探针页的 tabId 应能反查到').toBeGreaterThan(0)
    expect(otherTabId, '另一页的 tabId 应能反查到').toBeGreaterThan(0)

    // 起手：这两页上没有脚本在跑（本 spec 一个用户脚本都没装）→ 角标里不该有计数
    await expectNoScriptBadge(sw, otherTabId!)
    await expectNoScriptBadge(sw, probeTabId!)

    // 会话在跑：登记进「进行中」（工作台「会话历史」的状态标与停止入口靠它），**角标纹丝不动**
    // —— 它只数脚本
    await pushOffscreen({ kind: 'chat:running', conversationId: c1 })
    await expect.poll(() => runningOf(messenger)).toEqual([c1])
    await expectNoScriptBadge(sw, otherTabId!)

    // 收尾 → 从进行中撤下（没人在看的那些事不再有别的落点，见文件头注释）
    await pushOffscreen({ kind: 'chat:finished', conversationId: c1 })
    await expect
      .poll(() => runningOf(messenger), { message: '收尾后不该还挂在进行中' })
      .toEqual([])
    await expectNoScriptBadge(sw, otherTabId!)

    // 另一页同样：会话状态与它自己的角标无关
    await pushOffscreen({ kind: 'chat:running', conversationId: c2 })
    await expect.poll(() => runningOf(messenger)).toEqual([c2])
    await expectNoScriptBadge(sw, probeTabId!)
    await pushOffscreen({ kind: 'chat:finished', conversationId: c2 })
    await expect.poll(() => runningOf(messenger)).toEqual([])

    await page.close()
    await otherPage.close()
  })

  /**
   * ⚠️ **暂时跳过**：本条的起手 `openFloatPage` 要探活浮层宿主 —— 与下方「真实浮层链路」那组同一个
   * 病灶（件已在注册表里、页面却不答，`page.reload()` 也救不回，CI 上偶发，根因未定）。
   * 本 spec 余下两条不走浮层，不受影响；恢复时去掉 `.skip`。
   */
  test.skip('对话框：平时不注入，打开即挂出来，收起只藏不销毁', async () => {
    test.skip(!engineAvailable, 'chrome.userScripts 引导失败：宿主件装不上，浮层链路转手测')
    const { page, tabId } = await openFloatPage(context!, sw, probeUrl)

    // 起手：页面里连根节点都没有 —— 宿主件只在收到 float:open 时才建
    await expect(page.locator('#duoling-float-root')).toHaveCount(0)

    // 打开（popup 的按钮与页面右键菜单发的就是这条消息）
    await sendFloat(sw, tabId, 'float:open')
    const panel = await waitForPanelFrame(page)
    await expect(page.locator('#duoling-float-root .dl-float-container')).toHaveClass(/open/)

    // 收起：点对话框顶栏那颗**真按钮** —— 它是这条链路里唯一跨源的一步（按钮在 iframe 里、
    // 容器在父页），拿「发一条消息」代过就只剩替身了。
    await panel.getByLabel('收起').click()
    await expect(page.locator('#duoling-float-root .dl-float-container')).not.toHaveClass(/open/)
    // 只藏不销毁：容器仍在 DOM 里（iframe、草稿、滚动位置都留着，再打开就是原状态）
    await expect(page.locator('#duoling-float-root')).toHaveCount(1)

    await page.close()
  })
})

/**
 * 引导 userScripts 引擎：先起一次把两道开关打开，再关掉（开关随 profile 持久化，重启后生效）。
 *
 * 本 spec 两组都要先走这一道 —— 浮层宿主件（`dl-float-host`）是注册用户脚本，引擎没开时页面里
 * 根本没有它，`float:open` 无人接（见文件头）。姿势与 action-badge.spec.ts 共用。
 */
async function bootstrapEngine(profileDir: string): Promise<void> {
  const bootstrapCtx = await launchExtensionContext(profileDir)
  const bootstrapSw = await getServiceWorker(bootstrapCtx)
  await enableUserScripts(bootstrapCtx, extensionIdFromServiceWorker(bootstrapSw))
  await bootstrapCtx.close()
}

/** 探针页（可能同时开着多个同址标签页）→ tabId 列表 */
async function tabIdsOf(sw: Worker, url: string): Promise<number[]> {
  return await sw.evaluate(
    async (u) => (await chrome.tabs.query({})).filter((t) => t.url === u).map((t) => t.id ?? -1),
    url,
  )
}

/**
 * 「会话没有点亮角标」的判据：角标只报「这个标签页在跑几个脚本」，而本 spec 一个用户脚本都没装 ——
 * 所以任何一页的角标都**不该出现脚本计数**。
 *
 * 刻意不写死空串：角标本身随引擎状态变 —— 引擎引导失败时是**全局** `!`（判据与文案见
 * action-badge.spec.ts 的未授权那组），而那是扩展级状态，与「有没有会话在跑」无关。悬停文案同理：
 * 它只该说脚本的事。
 */
async function expectNoScriptBadge(sw: Worker, tabId: number): Promise<void> {
  expect(
    await sw.evaluate(async (id) => await chrome.action.getBadgeText({ tabId: id }), tabId),
    '会话状态不该让角标出现脚本计数',
  ).not.toMatch(/^\d+$/)
  expect(
    await sw.evaluate(async (id) => await chrome.action.getTitle({ tabId: id }), tabId),
    '悬停文案只该说脚本的事',
  ).not.toContain('个脚本在运行')
}

/**
 * 问 SW 要一份「进行中」快照（滚动的会话 id 列表，命令见 extension-ipc 的 sw:runningChats）。
 *
 * 会话状态**不进角标**（角标只报脚本运行数，见 action-badge.spec.ts），故本 spec 一律从这里观察 ——
 * 它也是工作台「会话历史」给「生成中」标与停止按钮的数据源。
 * 发送端必须是扩展页：runtime 消息不回环到 SW 自身上下文（见 extension.ts 的说明）。
 * 命令没应答（SW 未起等）时给一份空列表，让断言自己等到超时，而不是在这里抛错。
 */
async function runningOf(sender: Page): Promise<string[]> {
  const res = (await sender.evaluate(
    async () => await chrome.runtime.sendMessage({ kind: 'sw:runningChats' }),
  )) as { ok: boolean; data?: string[] } | undefined
  return res?.ok ? (res.data ?? []) : []
}

/** 浮层宿主常驻件的注册 id（探针页只关心这一件，见 waitForFloatHostRegistered） */
const FLOAT_HOST_ID = 'dl-float-host'

/**
 * 等浮层宿主**进注册表** —— 开探针页之前必须过这一道。
 *
 * 注册件只在**页面开始加载**时注入，而注册本身是 SW 启动链里的一段（读库 → 脚本桥 → 页面检查器
 * → 浮层宿主），每件之间还隔着几次 userScripts API 往返。页面若抢在这条链走完之前发起加载，那一页
 * 上就永远没有宿主件。
 *
 * 这个抢跑窗口真实存在、且**不能靠消息探活兜**：同一段链里页面检查器注册得更早（见
 * engine.ts 的 runRegisterAllEnabled），它也在这一页上收 `tabs.sendMessage` —— 于是「发消息没抛错」
 * 既可能来自浮层宿主，也可能只来自检查器，判不出来（这也是探活要看**应答**、不看通道的由来）。
 *
 * 过了这一道也还不等于「这一页上就能注入」：入册到 Chrome 侧生效之间另有一段窗口，那是
 * openFloatPage 重载兜底要处理的事。
 */
async function waitForFloatHostRegistered(sw: Worker): Promise<void> {
  await expect
    .poll(
      async () =>
        await sw.evaluate(async (id) => {
          try {
            return (await chrome.userScripts.getScripts()).some((s) => s.id === id)
          } catch {
            return false
          }
        }, FLOAT_HOST_ID),
      { timeout: 15_000, message: '浮层宿主没进注册表：SW 启动链没走完，或引擎引导失败' },
    )
    .toBe(true)
}

/** 浮层宿主件此刻在**这一页**上吗 —— 看应答（`content:ping` 只有它答），不看通道（见上） */
async function pingFloatHost(sw: Worker, tabId: number): Promise<boolean> {
  try {
    const pong = await sw.evaluate(
      async (id) => await chrome.tabs.sendMessage(id, { kind: 'content:ping' }),
      tabId,
    )
    return (pong as { ok?: boolean } | undefined)?.ok === true
  } catch {
    return false
  }
}

/**
 * 开一张「浮层宿主已就位」的探针页：等注册 → 开页 → 探活。
 *
 * 三步的顺序就是这条链路的顺序要求：注册早于开页（否则这一页上永远没有宿主件），开页早于探活
 * （否则问的是上一张页）。判据取探活而非「消息发得出去」的理由见 waitForFloatHostRegistered。
 *
 * 探活不通就**重载一次再来**：件进了注册表，Chrome 侧「把这条注册同步到自动注入」还有一段窗口
 * （冷启动的 context 上最容易撞上，真机上同一个窗口的表现就是「刷新一下就能开」）。注入只在页面
 * 开始加载那一刻发生，这一页错过了就补不回来 —— 所以是重载，不是多等一会儿。重载后仍不通才按
 * 真失败报：那时不该再赖这个窗口。
 */
async function openFloatPage(
  context: BrowserContext,
  sw: Worker,
  url: string,
): Promise<{ page: Page; tabId: number }> {
  await waitForFloatHostRegistered(sw)
  const page = await context.newPage()
  await page.goto(url)
  const [tabId] = await tabIdsOf(sw, url)
  expect(tabId, '探针页的 tabId 应能反查到').toBeGreaterThan(0)

  /** 探活到有应答为止；到点没应答就抛，由调用方决定要不要重载 */
  const pingUntilReady = async (message: string): Promise<void> => {
    await expect
      .poll(() => pingFloatHost(sw, tabId!), { timeout: 15_000, message })
      .toBe(true)
  }

  try {
    await pingUntilReady('浮层宿主没应答：这一页加载时它还没注册（或引擎引导失败）')
  } catch {
    await page.reload()
    await pingUntilReady('浮层宿主没应答：重载后仍没注入 —— 不是冷启动那个同步窗口了')
  }
  return { page, tabId: tabId! }
}

/**
 * 给某标签页发一条浮层指令（`float:open` / `float:collapse`）。
 *
 * 页面里没有可点的入口（对话框平时不在页面里），这两条定向消息就是它的开关 —— 与 popup 的按钮、
 * 页面右键菜单、对话框顶栏那颗「收起」是同一套契约。发送方那侧的行为由 PopupPanel 的组件测试
 * 覆盖，这里只借扩展页代发一下。不吞错：宿主件已由 openFloatPage 探通，发不出去就是真失败。
 */
async function sendFloat(
  sw: Worker,
  tabId: number,
  kind: 'float:open' | 'float:collapse',
): Promise<void> {
  await sw.evaluate(
    async ({ id, k }) => {
      // tabId 随消息带上：真发送方（popup / 右键菜单）都握有它，宿主件靠它拼 iframe URL 的 `?tab=`
      await chrome.tabs.sendMessage(id, { kind: k, tabId: id })
    },
    { id: tabId, k: kind },
  )
}

/**
 * 上一条走的是「假会话 + 直推 offscreen 事件」，验的是 SW 侧对进行中的登记；这条走**真链路**：
 * 本地模型 stub 让任务真的跑起来，浮层是页面里那个真 iframe，停止 / 关标签页都是真动作。
 * 之所以能这么走：stub 把「生成中」的窗口拉长，才来得及在生成期间做断言。
 *
 * ⚠️ **整组暂时跳过**：本组 `beforeAll` 开出的浮层探活会偶发失败 —— 宿主件已在注册表里、页面却不答，
 * `page.reload()` 也救不回，CI 上约三成运行由此整组塌。根因未定（怀疑自定义世界 `us-dl-float` 的
 * messaging 配置某一刻没生效），本地 20 轮未复现，症状疑似与 TODO.md 那条「dev 重启竞态」同源。
 * 恢复时去掉本行 `.skip`，并给 `describe` 带上 `serial` —— 两条用例有先后依赖。
 */
test.describe.skip('真实浮层链路（模型 stub + 页面内 iframe）', () => {
  let context: BrowserContext | undefined
  let sw: Worker
  let extensionId = ''
  let stub: Awaited<ReturnType<typeof startModelStub>>
  let profileDir = ''
  let probe: http.Server | undefined
  let probeUrl = ''
  /** 引擎是否真的可用（引导失败时本组两条都转手测，见文件头） */
  let engineAvailable = false

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-taskstate-live-'))
    stub = await startModelStub({ delayMs: 6_000 })

    await bootstrapEngine(profileDir)
    context = await launchExtensionContext(profileDir)
    sw = await getServiceWorker(context)
    extensionId = extensionIdFromServiceWorker(sw)
    engineAvailable = await checkUserScriptsAvailable(sw)

    probe = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body><h1>probe</h1></body></html>')
    })
    await new Promise<void>((resolve) => probe!.listen(0, '127.0.0.1', () => resolve()))
    const addr = probe.address()
    if (!addr || typeof addr === 'string') throw new Error('探针页地址取不到')
    probeUrl = `http://127.0.0.1:${addr.port}/`

    // 引导失败就没有浮层可配，本组两条都会 skip（见各自开头）—— 这一步不必硬做
    if (!engineAvailable) return

    // 模型指向本地 stub —— 本组用例的环境前提：真链路得先有能应答的模型，任务才跑得起来。
    // 只能在浮层这一侧配（`window.api` 只装给浮层，popup 是纯配置面板）；配完落进扩展存储，
    // 后面用例新开的浮层直接可用，故整组只在这里配一次。
    const { page: setupPage, tabId: setupTabId } = await openFloatPage(context!, sw, probeUrl)
    await sendFloat(sw, setupTabId, 'float:open')
    await configureStubModel(await waitForPanelFrame(setupPage), stub.stub.baseUrl)
    await setupPage.close()
  })

  test.afterAll(async () => {
    const withTimeout = (p: Promise<unknown> | undefined, ms: number) =>
      p ? Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve()
    try { await withTimeout(context?.close(), 30_000) } catch { /* 忽略 */ }
    try {
      stub?.server.closeAllConnections()
      await withTimeout(new Promise<void>((r) => stub?.server.close(() => r())), 5_000)
    } catch { /* 忽略 */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })

  test('点浮层里的停止：任务就地中止，半截照样落盘（带「已中断」）', async () => {
    test.skip(!engineAvailable, 'chrome.userScripts 引导失败：宿主件装不上，浮层链路转手测')
    // 首片之后再按住：这样「停止」时已经有一点内容，能验到「保住半截」这件事
    stub.setOptions({ delayMs: 0, holdAfterFirstChunkMs: 5_000 })

    const { page, tabId } = await openFloatPage(context!, sw, probeUrl)
    await sendFloat(sw, tabId, 'float:open')
    const panel = await waitForPanelFrame(page)
    const box = panel.getByRole('textbox').first()
    await box.fill('停我')
    await box.press('Enter')

    // 首片文本到了 = 已生成一点内容，而 stub 正按住第二片 —— 此刻点停止。
    // 浮层里流式中的那个提交按钮就是停止按钮（见 ChatPanel.onPromptSubmit）。
    await expect(panel.getByText(/stub/).first()).toBeVisible({ timeout: 20_000 })
    // 生成中：页面盖着遮罩（对话界面经 float:busy 报的）—— 面板本体在遮罩之上，故这颗按钮点得到
    await expect(page.locator('#duoling-float-root .dl-page-mask')).toBeVisible()
    await panel.getByLabel('Submit').click()
    // 停止 = 不再生成 → 遮罩撤掉
    await expect(page.locator('#duoling-float-root .dl-page-mask')).toBeHidden()

    // 落盘：最新那条会话里应有半截 assistant 消息，并带「已中断」标记。
    // （不断言浮层当场显示 —— 点停止时 UI 已本地断流，标记是给回看用的。）
    const reader = await context!.newPage()
    await reader.goto(`chrome-extension://${extensionId}/workbench.html`)
    interface StoredMessage {
      role: string
      content: string
      parts: Array<{ type: string }>
    }
    const readLatest = async (): Promise<StoredMessage[]> =>
      await reader.evaluate(async () => {
        const api = (
          window as unknown as {
            api: {
              conversation: {
                list: () => Promise<Array<{ id: string }>>
                messages: (id: string) => Promise<StoredMessage[]>
              }
            }
          }
        ).api
        const list = await api.conversation.list()
        return list.length ? await api.conversation.messages(list[0]!.id) : []
      })

    await expect
      .poll(async () => (await readLatest()).some((m) => m.role === 'assistant'), {
        timeout: 10_000,
        message: '点停止后，已生成的那半截也要落盘',
      })
      .toBe(true)
    const assistant = (await readLatest()).find((m) => m.role === 'assistant')
    expect(
      assistant?.parts.some((p) => p.type === 'data-interrupted'),
      '半截要带「已中断」标记',
    ).toBe(true)
    expect(assistant?.content ?? '', '半截内容要留住').toContain('stub')

    await reader.close()
    stub.setOptions({ delayMs: 6_000, holdAfterFirstChunkMs: 0 })
    await page.close()
  })

  test('关掉标签页：任务就地中止、半截照样落盘（带「已中断」）', async () => {
    test.skip(!engineAvailable, 'chrome.userScripts 引导失败：宿主件装不上，浮层链路转手测')
    const sender = await openMessengerPage(context!, extensionId)

    // 这条要验「已生成的部分不丢」，所以得让 stub **先吐一片内容再停住** ——
    // 光在吐字节前卡住（delayMs）中止时什么都没生成，落盘自然也没什么可验。
    stub.setOptions({ delayMs: 0, holdAfterFirstChunkMs: 5_000 })

    const { page, tabId } = await openFloatPage(context!, sw, probeUrl)
    await sendFloat(sw, tabId, 'float:open')
    const box = (await waitForPanelFrame(page)).getByRole('textbox').first()
    await box.fill('你好')
    await box.press('Enter')

    // 生成已开始（stub 收到请求，此刻正卡在它的延时里）→ 进行中登记里有它
    const before = stub.stub.hits.length
    await expect.poll(() => stub.stub.hits.length, { timeout: 30_000 }).toBeGreaterThan(before)
    await expect
      .poll(async () => (await runningOf(sender)).length, { timeout: 10_000 })
      .toBe(1)
    const conversationId = (await runningOf(sender))[0]
    expect(conversationId, '生成中应能在进行中登记里看到').toBeTruthy()

    // 收起浮层不影响遮罩：判据只有「在不在生成」，收起只是收起对话界面，页面照样在被读
    await sendFloat(sw, tabId, 'float:collapse')
    await expect(page.locator('#duoling-float-root .dl-page-mask')).toBeVisible()

    // 关掉这个标签页 = 那条会话的现场没了 → 任务应当被就地中止（否则它在 offscreen 里跑完，
    // 用户既看不到结果、也没处按停止）
    await page.close()
    await expect
      .poll(async () => (await runningOf(sender)).length, {
        timeout: 10_000,
        message: '关了标签页，那条会话就不该还在跑',
      })
      .toBe(0)

    // 已生成的那部分要落盘（半截也留），并带「已中断」标记 —— 丢掉才是真丢信息
    const reader = await context!.newPage()
    await reader.goto(`chrome-extension://${extensionId}/workbench.html`)
    interface StoredMessage {
      role: string
      parts: Array<{ type: string }>
    }
    const readMessages = async (): Promise<StoredMessage[]> =>
      await reader.evaluate(
        async (cid) =>
          await (
            window as unknown as {
              api: { conversation: { messages: (id: string) => Promise<StoredMessage[]> } }
            }
          ).api.conversation.messages(cid),
        conversationId!,
      )

    await expect
      .poll(async () => (await readMessages()).some((m) => m.role === 'assistant'), {
        timeout: 10_000,
        message: '中止后的半截也该落进会话历史',
      })
      .toBe(true)
    const assistant = (await readMessages()).find((m) => m.role === 'assistant')
    expect(
      assistant?.parts.some((p) => p.type === 'data-interrupted'),
      '半截要带「已中断」标记（否则事后会以为是完整回复）',
    ).toBe(true)
    await reader.close()

    stub.setOptions({ delayMs: 6_000, holdAfterFirstChunkMs: 0 }) // 恢复默认节奏
    await sender.close()
  })
})

/** 等对话框 iframe 出现（收到 float:open 后宿主件才建 DOM、给它设 src） */
async function waitForPanelFrame(page: Page): Promise<Frame> {
  for (let i = 0; i < 100; i++) {
    const frame = page.frames().find((f) => f.url().includes('floatpanel.html'))
    if (frame) return frame
    await page.waitForTimeout(200)
  }
  // 超时把现场一并带出来（不然只剩一句猜）：三档状态各指一处不同的病 —— 没有宿主根节点 = 件没接到
  // 指令（这一页上根本没注入）；有根节点但 iframe 没 src = 件已降级（浮层页地址取不到，或站点拦了
  // 扩展 iframe）；src 有值 = iframe 没加载出来。对话框在 shadow root 里，document.query 穿不过去，
  // 故往 shadowRoot 钻一层。
  const seen = await page.evaluate(() => {
    const root = document.querySelector('#duoling-float-root')
    const iframe = root?.shadowRoot?.querySelector('iframe')
    return { root: !!root, src: iframe?.getAttribute('src') ?? null }
  })
  throw new Error(
    `浮层 iframe 未出现：宿主根节点${seen.root ? '在' : '不在'}、iframe src=${String(seen.src)}；` +
      `本页的帧 = ${page.frames().map((f) => f.url()).join(' | ') || '(无)'}`,
  )
}

/**
 * 把模型 profile 指向本地 stub（`api.model.save` + `setActive`）—— 真链路才有东西可跑。
 *
 * 只能在浮层这一侧配：`window.api` 只装给浮层（popup 是纯配置面板）。配完落进扩展存储，
 * 之后新开的浮层直接可用，故整组用例只配一次（见上面 describe 的 beforeAll）。
 * 先等 `api.model` 挂上再动手 —— 浮层文档刚建好时 `window.api` 还没就绪。
 */
async function configureStubModel(panel: Frame, baseUrl: string): Promise<void> {
  await panel.waitForFunction(() => !!(window as unknown as { api?: { model?: unknown } }).api?.model)
  await panel.evaluate(
    async (cfg) => {
      const api = (
        window as unknown as {
          api: {
            model: {
              save: (c: unknown) => Promise<{ id: string }>
              setActive: (id: string) => Promise<void>
            }
          }
        }
      ).api
      const p = await api.model.save(cfg)
      await api.model.setActive(p.id)
    },
    { name: 'stub', baseUrl, apiKey: 'sk-stub', model: 'stub-model' },
  )
}
