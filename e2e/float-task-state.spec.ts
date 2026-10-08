// 会话状态外显的端测：**角标不参与**（它只报「这个标签页在跑几个脚本」，见 action-badge.spec.ts），
// 会话这边的落点只有一处 —— SW 内存里的「进行中」登记表（工作台「会话历史」的「生成中」标与
// 停止入口靠它，见 use-chat-running）。
//
// 于是本 spec 收窄成两件事：
//   1. 会话状态与角标无关：在跑 / 跑完都不点亮角标（防回归 —— 这条曾经是角标的全部职责）；
//   2. 进行中登记的进出：任务开跑就登记、收尾就撤下、关标签页要中止并撤下。
//
// 第 1 条的判据是「角标里不出现脚本计数」而非「角标为空」：本 spec 的 profile 不引导 userScripts，
// 引擎未授权时角标是**全局** `!`（见 action-badge.spec.ts 的未授权那组），CI 上就是这个前提。
//
// 另有一条守「对话框的显隐」：页面里平时不注入任何 DOM，收到 float:open 才挂出来，收起只把容器
// 藏起来（iframe 与面板文档留在原位，再打开就是原状态）。
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
  extensionIdFromServiceWorker,
  getServiceWorker,
  launchExtensionContext,
  openMessengerPage,
} from './extension'
import { startModelStub } from './model-stub'

test.describe.serial('任务状态外显（进行中登记 + 对话框显隐）', () => {
  let context: BrowserContext | undefined
  let sw: Worker
  let messenger: Page
  let profileDir = ''
  let probe: http.Server | undefined
  let probeUrl = ''

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-taskstate-e2e-'))
    context = await launchExtensionContext(profileDir)
    sw = await getServiceWorker(context)
    messenger = await openMessengerPage(context, extensionIdFromServiceWorker(sw))

    // 本地探针页：content script 的 matches 是 http(s)，file:// 匹配不上（与 smoke 同做法）
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

  test('对话框：平时不注入，打开即挂出来，收起只藏不销毁', async () => {
    const page = await context!.newPage()
    await page.goto(probeUrl)
    const [tabId] = await tabIdsOf(sw, probeUrl)
    expect(tabId, '探针页的 tabId 应能反查到').toBeGreaterThan(0)

    // 起手：页面里连根节点都没有 —— content script 只在收到 float:open 时才建
    await expect(page.locator('#duoling-float-root')).toHaveCount(0)

    // 打开（popup 的按钮与页面右键菜单发的就是这条消息）
    await expect
      .poll(() => trySendFloat(sw, tabId!, 'float:open'), { timeout: 15_000 })
      .toBe(true)
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
 * 刻意不写死空串：本 spec 的 profile 不引导 userScripts，引擎未授权时角标是**全局** `!`
 * （判据与文案见 action-badge.spec.ts 的未授权那组），CI 上跑的就是这种情形 —— 那是扩展级状态，
 * 与「有没有会话在跑」无关。悬停文案同理：它只该说脚本的事。
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

/**
 * 给某标签页发一条浮层消息（`float:open` / `float:collapse`）；页面还没接上时返回 false。
 *
 * 页面里没有可点的入口（对话框平时不在页面里），这两条定向消息就是它的开关 —— 与 popup 的按钮、
 * 页面右键菜单、对话框顶栏那颗「收起」是同一套契约。发送方那侧的行为由 PopupPanel 的组件测试
 * 覆盖，这里只借扩展页代发一下。
 *
 * 幂等：重复发 float:open 只是再 open 一次，所以可以拿它当「内容脚本就绪了没」的探针重试。
 */
async function trySendFloat(
  sw: Worker,
  tabId: number,
  kind: 'float:open' | 'float:collapse',
): Promise<boolean> {
  try {
    await sw.evaluate(
      async ({ id, k }) => {
        await chrome.tabs.sendMessage(id, { kind: k })
      },
      { id: tabId, k: kind },
    )
    return true
  } catch {
    return false // 页面还没接上扩展（内容脚本未注入完 / 扩展正在更新）
  }
}

/**
 * 上一条走的是「假会话 + 直推 offscreen 事件」，验的是 SW 侧对进行中的登记；这条走**真链路**：
 * 本地模型 stub 让任务真的跑起来，浮层是页面里那个真 iframe，停止 / 关标签页都是真动作。
 * 之所以能这么走：stub 把「生成中」的窗口拉长，才来得及在生成期间做断言。
 */
test.describe.serial('真实浮层链路（模型 stub + 页面内 iframe）', () => {
  let context: BrowserContext | undefined
  let sw: Worker
  let extensionId = ''
  let stub: Awaited<ReturnType<typeof startModelStub>>
  let profileDir = ''
  let probe: http.Server | undefined
  let probeUrl = ''

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-taskstate-live-'))
    stub = await startModelStub({ delayMs: 6_000 })
    context = await launchExtensionContext(profileDir)
    sw = await getServiceWorker(context)
    extensionId = extensionIdFromServiceWorker(sw)

    probe = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body><h1>probe</h1></body></html>')
    })
    await new Promise<void>((resolve) => probe!.listen(0, '127.0.0.1', () => resolve()))
    const addr = probe.address()
    if (!addr || typeof addr === 'string') throw new Error('探针页地址取不到')
    probeUrl = `http://127.0.0.1:${addr.port}/`

    // 模型指向本地 stub —— 本组用例的环境前提：真链路得先有能应答的模型，任务才跑得起来。
    // 只能在浮层这一侧配（`window.api` 只装给浮层，popup 是纯配置面板）；配完落进扩展存储，
    // 后面用例新开的浮层直接可用，故整组只在这里配一次。
    const setupPage = await context.newPage()
    await setupPage.goto(probeUrl)
    const [setupTabId] = await tabIdsOf(sw, probeUrl)
    await expect.poll(() => trySendFloat(sw, setupTabId!, 'float:open'), { timeout: 15_000 }).toBe(true)
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
    // 首片之后再按住：这样「停止」时已经有一点内容，能验到「保住半截」这件事
    stub.setOptions({ delayMs: 0, holdAfterFirstChunkMs: 5_000 })

    const page = await context!.newPage()
    await page.goto(probeUrl)
    const [tabId] = await tabIdsOf(sw, probeUrl)
    await expect.poll(() => trySendFloat(sw, tabId!, 'float:open'), { timeout: 15_000 }).toBe(true)
    const panel = await waitForPanelFrame(page)
    const box = panel.getByRole('textbox').first()
    await box.fill('停我')
    await box.press('Enter')

    // 首片文本到了 = 已生成一点内容，而 stub 正按住第二片 —— 此刻点停止。
    // 浮层里流式中的那个提交按钮就是停止按钮（见 ChatPanel.onPromptSubmit）。
    await expect(panel.getByText(/stub/).first()).toBeVisible({ timeout: 20_000 })
    await panel.getByLabel('Submit').click()

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
    const sender = await openMessengerPage(context!, extensionId)

    // 这条要验「已生成的部分不丢」，所以得让 stub **先吐一片内容再停住** ——
    // 光在吐字节前卡住（delayMs）中止时什么都没生成，落盘自然也没什么可验。
    stub.setOptions({ delayMs: 0, holdAfterFirstChunkMs: 5_000 })

    const page = await context!.newPage()
    await page.goto(probeUrl)
    const [tabId] = await tabIdsOf(sw, probeUrl)
    await expect.poll(() => trySendFloat(sw, tabId!, 'float:open'), { timeout: 15_000 }).toBe(true)
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

/** 等对话框 iframe 出现（收到 float:open 后 content script 才去取 tabId、再给它设 src） */
async function waitForPanelFrame(page: Page): Promise<Frame> {
  for (let i = 0; i < 100; i++) {
    const frame = page.frames().find((f) => f.url().includes('floatpanel.html'))
    if (frame) return frame
    await page.waitForTimeout(200)
  }
  throw new Error('浮层 iframe 未出现：该站点可能拦了扩展 iframe，或这一下点击没生效')
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
