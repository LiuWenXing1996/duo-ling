// 会话状态外显的端测：**角标不参与**（它只报「这个标签页在跑几个脚本」，见 action-badge.spec.ts），
// 会话这边只有一条落点 —— 没人在看时跑完，记一条未读通知（popup 明细的来源）。
//
// 于是本 spec 收窄成两件事：
//   1. 会话状态与角标无关：在跑 / 跑完都不点亮角标（防回归 —— 这条曾经是角标的全部职责）；
//   2. 通知的去向：没人看就记、回到「在看」就标已读、会话删了就连带清掉。
//
// 第 1 条的判据是「角标里不出现脚本计数」而非「角标为空」：本 spec 的 profile 不引导 userScripts，
// 引擎未授权时角标是**全局** `!`（见 action-badge.spec.ts 的未授权那组），CI 上就是这个前提。
//
// 另有一条守「对话框的显隐」：页面里平时不注入任何 DOM，收到 float:open 才挂出来并连上
// 「在看」端口（`duoling:panel-open`），收起又把端口断掉。
//
// 页面内没有可点的入口（对话框平时不在页面里），故打开 / 收起一律走那两条定向消息 ——
// 与 popup 的按钮、页面右键菜单、对话框顶栏那颗「收起」是同一套契约（发送方那侧的行为由
// PopupPanel 的组件测试覆盖）。无头下也没有「在 iframe 里发消息」那条路，见 smoke.spec.ts
// 头注释。
//
// 推假会话的那几条要先给它认领一个标签页（通知里带站点名、判「有没有人看着」都靠这条归属）：
// 绑定直接写 convByTab（duoling-app 库的键），见 bindConversations。绑定**怎么建立**由
// conversation-tab-map 单测与 chat-stub 端测覆盖，这里只借它把状态推上来 ——
// 库名 / store / 键名改动时与本 spec 一起改。
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

/** 假会话 id：状态推送不需要真会话存在，给个不会与别的用例撞上的即可 */
const CID = 'e2e-task-state'

test.describe.serial('任务状态外显（未读通知 + 对话框显隐）', () => {
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

  test('会话状态不进角标（角标只报脚本运行数）；未读通知照记、按会话标已读', async () => {
    const c1 = 'e2e-count-1'
    const c2 = 'e2e-count-2'

    // 通知里要带站点名、判「有没有人看着」也要靠会话的标签页归属，故先给两条假会话各认领一页。
    // 一个标签页只归属一条会话（convByTab 是 tab → 单条会话），正好用两页来验「各算各的」。
    //
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
    await bindConversations(messenger, otherTabId!, [c1])
    await bindConversations(messenger, probeTabId!, [c2])

    // 起手：这两页上没有脚本在跑（本 spec 一个用户脚本都没装）→ 角标里不该有计数
    await expectNoScriptBadge(sw, otherTabId!)
    await expectNoScriptBadge(sw, probeTabId!)

    // 会话在跑：登记进「进行中」（popup 的进行中组靠它），**角标纹丝不动** —— 它只数脚本
    await pushOffscreen({ kind: 'chat:running', conversationId: c1 })
    await expect.poll(async () => (await notifySnapshot(messenger)).running).toEqual([c1])
    await expectNoScriptBadge(sw, otherTabId!)

    // 跑完且没人看着 → 记一条未读；角标依旧不亮（那条信息只在 popup 明细里）
    await pushOffscreen({ kind: 'chat:finished', conversationId: c1 })
    await expect
      .poll(() => unreadOf(messenger), { message: '跑完没人在看，该记一条未读' })
      .toEqual([c1])
    await expectNoScriptBadge(sw, otherTabId!)
    expect((await notifySnapshot(messenger)).running, '收尾后不该还挂在进行中').toEqual([])

    // 全部已读：未读清掉（popup 那条随之消失）
    await messenger.evaluate(async () => await chrome.runtime.sendMessage({ kind: 'notify:readAll' }))
    await expect.poll(() => unreadOf(messenger)).toEqual([])

    // 另一页同样：会话状态与它自己的角标无关
    await pushOffscreen({ kind: 'chat:running', conversationId: c2 })
    await pushOffscreen({ kind: 'chat:finished', conversationId: c2 })
    await expect.poll(() => unreadOf(messenger)).toEqual([c2])
    await expectNoScriptBadge(sw, probeTabId!)

    await messenger.evaluate(async () => await chrome.runtime.sendMessage({ kind: 'notify:readAll' }))
    await page.close()
    await otherPage.close()
  })

  test('popup：通知区给出明细，「全部已读」清掉该块', async () => {
    const id = extensionIdFromServiceWorker(sw)
    // 清场后造一条：一个假会话跑完、没人看（没人看着 = 那两个标签页上都没有展开的浮层）
    await messenger.evaluate(async () => await chrome.runtime.sendMessage({ kind: 'notify:readAll' }))
    await pushOffscreen({ kind: 'chat:running', conversationId: 'e2e-popup-cid' })
    await pushOffscreen({ kind: 'chat:finished', conversationId: 'e2e-popup-cid' })
    await expect.poll(() => unreadOf(messenger)).toEqual(['e2e-popup-cid'])

    const popup = await context!.newPage()
    await popup.goto(`chrome-extension://${id}/popup.html`)
    await expect(popup.locator('[data-testid="popup-notifications"]')).toBeVisible()
    await expect(popup.locator('[data-testid="notify-item"]')).toHaveCount(1)

    await popup.locator('[data-testid="notify-read-all"]').click()
    await expect
      .poll(() => unreadOf(messenger), { message: '在 popup 里读过，未读就该清零' })
      .toEqual([])
    // 无通知时整块不渲染（常态 popup 保持原样）
    await expect(popup.locator('[data-testid="popup-notifications"]')).toHaveCount(0)
    await popup.close()
  })

  test('对话框：平时不注入，打开即连「在看」端口，收起又断', async () => {
    const page = await context!.newPage()
    await page.goto(probeUrl)
    const [tabId] = await tabIdsOf(sw, probeUrl)
    expect(tabId, '探针页的 tabId 应能反查到').toBeGreaterThan(0)
    // 会话归属：本用例推的是假会话，得让它先认领这个标签页 —— 通知带站点名、判「在看」都靠它。
    // 代写方是扩展页（写的是扩展自己的库），**不能拿下面这个 http 探针页代写**：那样落在页面的源里，
    // SW 读不到。见 bindConversations 的说明。
    await bindConversations(messenger, tabId!, [CID])

    // 起手：页面里连根节点都没有 —— content script 只在收到 float:open 时才建
    await expect(page.locator('#duoling-float-root')).toHaveCount(0)

    // 没人看着时跑完 → 记一条未读。这条正是「端口还没连上」的证据
    await pushOffscreen({ kind: 'chat:running', conversationId: CID })
    await pushOffscreen({ kind: 'chat:finished', conversationId: CID })
    await expect.poll(() => unreadOf(messenger), { message: '没人看，该记一条' }).toEqual([CID])

    // 打开（popup 的按钮与页面右键菜单发的就是这条消息）→ 端口接上
    await expect
      .poll(() => trySendFloat(sw, tabId!, 'float:open'), { timeout: 15_000 })
      .toBe(true)
    const panel = await waitForPanelFrame(page)
    await expect(page.locator('#duoling-float-root .dl-float-container')).toHaveClass(/open/)
    // 「人回来了并且看着它」：这条未读就地标掉
    await expect.poll(() => unreadOf(messenger), { message: '看着就该标已读' }).toEqual([])

    // ⚠️ 面板**挂载时会清掉上面那条绑定**（见 bindConversations 的说明），必须等它清完再补一次，
    // 否则下面「端口连着」那段反查不到标签页、照样记一条未读。补早了会与它抢，还是被删掉。
    await expect
      .poll(() => conversationIdOfTab(messenger, tabId!), {
        timeout: 10_000,
        message: '面板挂载会清掉指向不存在会话的陈旧映射',
      })
      .toBe(null)
    await bindConversations(messenger, tabId!, [CID])

    // 端口连着（= 在看）时收尾的任务不再打扰：等一小会儿，确认没有新通知冒出来
    await pushOffscreen({ kind: 'chat:running', conversationId: CID })
    await pushOffscreen({ kind: 'chat:finished', conversationId: CID })
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(await unreadOf(messenger), '人正看着，不该记未读').toEqual([])

    // 收起：点对话框顶栏那颗**真按钮** —— 它是这条链路里唯一跨源的一步（按钮在 iframe 里、
    // 容器在父页），拿「发一条消息」代过就只剩替身了。
    await panel.getByLabel('收起').click()
    await expect(page.locator('#duoling-float-root .dl-float-container')).not.toHaveClass(/open/)
    // 只藏不销毁：容器仍在 DOM 里（iframe、草稿、滚动位置都留着，再打开就是原状态）
    await expect(page.locator('#duoling-float-root')).toHaveCount(1)
    // 收起 = 又没人看着了 → 此后再收尾就要记
    await pushOffscreen({ kind: 'chat:running', conversationId: CID })
    await pushOffscreen({ kind: 'chat:finished', conversationId: CID })
    await expect
      .poll(() => unreadOf(messenger), { message: '没人看了，该重新记一条' })
      .toEqual([CID])

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

/** 通知快照里用得上的两栏（形状见 extension-ipc 的 NotificationSnapshot） */
interface NotifyView {
  /** 进行中的会话 id */
  running: string[]
  /** 未读通知的会话 id（已读的不算） */
  unread: string[]
}

/**
 * 问 SW 要一份通知快照。
 *
 * 会话状态**不再进角标**（角标只报脚本运行数，见 action-badge.spec.ts），故本 spec 一律从通知中心
 * 观察 —— 那正是「没人在看就跑完」这条链路唯一的落点（也是 popup 明细的来源）。
 * 发送端必须是扩展页：runtime 消息不回环到 SW 自身上下文（见 extension.ts 的说明）。
 * 命令没应答（SW 未起等）时给一份空快照，让断言自己等到超时，而不是在这里抛错。
 */
async function notifySnapshot(sender: Page): Promise<NotifyView> {
  const res = (await sender.evaluate(
    async () => await chrome.runtime.sendMessage({ kind: 'notify:list' }),
  )) as
    | {
        ok: true
        data: {
          running: Array<{ conversationId: string }>
          items: Array<{ conversationId: string; readAt?: number }>
        }
      }
    | { ok: false; error: string }
    | undefined
  if (!res?.ok) return { running: [], unread: [] }
  return {
    running: res.data.running.map((r) => r.conversationId),
    unread: res.data.items.filter((n) => n.readAt == null).map((n) => n.conversationId),
  }
}

/** 未读通知的会话 id —— 「跑完且没人看」唯一的可见落点 */
async function unreadOf(sender: Page): Promise<string[]> {
  return (await notifySnapshot(sender)).unread
}

/**
 * 让若干会话认领一个标签页（直接写 duoling-app 库的 `convByTab` 键）。
 *
 * 归属仍然要建：通知里那句站点名要靠 conversation-tab-map 反查所属标签页，判「有没有人看着」也走
 * 同一条路。本 spec 里有一组用例推的是不存在的假会话 id（只为验 SW 侧的记录与分发），走不到「在
 * 面板里发消息」那条建立归属的真实路径，故在这里替它们认领一个。一个标签页只归属一条会话（见
 * conversation-tab-map），同一个 tabId 上后写的会覆盖先写的 —— 要验多条并行，就得各自认领一页。
 *
 * 库名 / store / 键名改动时与本 spec 一起改。
 *
 * **`page` 必须是扩展页**（messenger / popup / workbench 这类）：这里走的是 `page.evaluate`，
 * IndexedDB 按**页面自己的源**隔离 —— 拿一个 http 探针页当代写方，写进去的是那个站点的库，
 * SW 读扩展自己的库时什么也看不到，绑定等于没建（症状：通知里没有站点名、回到「在看」也不标已读）。
 *
 * **假会话的绑定活不过「面板挂载」**：真面板起来时会按 tab 反查该显示哪条会话
 * （use-global-conversation 的 syncToTab），绑定的会话不在会话库里就判为陈旧映射、`unbindTab`。
 * 绑的既然是假会话（库里没有），就必被它清掉 —— 需要绑定一直有效的用例，得在面板起来后补一次
 * （见「对话框」那条用例的做法）。真实链路里这条清理是需要的：会话在别处被删后，映射不该留着
 * 继续指着一条已不存在的会话。
 */
async function bindConversations(
  page: Page,
  tabId: number,
  conversationIds: string[],
): Promise<void> {
  await page.evaluate(
    async ({ id, ids }) => {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('duoling-app', 1)
        open.onupgradeneeded = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' })
        }
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction('kv', 'readwrite')
          const store = tx.objectStore('kv')
          const read = store.get('convByTab')
          read.onsuccess = () => {
            const prev = (read.result as { value?: Record<string, string> } | undefined)?.value ?? {}
            const next: Record<string, string> = { ...prev }
            for (const conversationId of ids) next[String(id)] = conversationId
            store.put({ key: 'convByTab', value: next })
          }
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      })
    },
    { id: tabId, ids: conversationIds },
  )
}

/**
 * 反查某标签页当前归属的会话 id（没绑定返回 null）—— `bindConversations` 的读侧。
 *
 * 用来观察**别人**对这条映射的改动：真面板起来时会顺手清掉指向不存在会话的陈旧映射（见
 * bindConversations 的说明），本 spec 就靠它等到「清完了」再补绑，而不是与面板抢着写。
 * 代写方同样必须是扩展页（IndexedDB 按页面源隔离）。
 */
async function conversationIdOfTab(sender: Page, tabId: number): Promise<string | null> {
  return await sender.evaluate(async (id) => {
    return await new Promise<string | null>((resolve, reject) => {
      const open = indexedDB.open('duoling-app', 1)
      open.onupgradeneeded = () => {
        const db = open.result
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' })
      }
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction('kv', 'readonly')
        const read = tx.objectStore('kv').get('convByTab')
        read.onerror = () => reject(read.error)
        read.onsuccess = () => {
          const value = (read.result as { value?: Record<string, string> } | undefined)?.value ?? {}
          resolve(value[String(id)] ?? null)
        }
        tx.oncomplete = () => db.close()
      }
    })
  }, tabId)
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
 * 上一条走的是「假会话 + 代连端口」，验的是 SW 侧的分发；这条走**真链路**：
 * 本地模型 stub 让任务真的跑起来，浮层是页面里那个真 iframe，收起 / 展开都是真点击。
 * 之所以能这么走：stub 把「生成中」的窗口拉长，才来得及在生成期间收起浮层做断言。
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

  test('发消息：看着就不记未读；收起后跑完记一条，展开即标已读', async () => {
    // 发送端先开（须在探针页之前）—— 后开的标签页才是前台那一个，而「页面可见」是「在看」的判据之一
    const sender = await openMessengerPage(context!, extensionId)
    const page = await context!.newPage()
    await page.goto(probeUrl)
    const [tabId] = await tabIdsOf(sw, probeUrl)

    // 真人路径：打开对话框 → 在面板里配模型（`window.api` 只有浮层这一侧装，popup 是纯配置
    // 面板）→ 填字回车。会话归属也由这条路径建立，不用测试代写 convByTab。
    await expect.poll(() => trySendFloat(sw, tabId!, 'float:open'), { timeout: 15_000 }).toBe(true)
    const panel = await waitForPanelFrame(page)
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
      { name: 'stub', baseUrl: stub.stub.baseUrl, apiKey: 'sk-stub', model: 'stub-model' },
    )
    const box = panel.getByRole('textbox').first()
    await box.fill('你好')
    await box.press('Enter')

    // 生成已开始（stub 收到请求）而对话框开着：人就在看 —— 这条任务收尾时不该进未读
    await expect.poll(() => stub.stub.hits.length, { timeout: 30_000 }).toBeGreaterThan(0)
    await expectNoScriptBadge(sw, tabId!)

    // 收起 = 人走了：跑完就得记一条未读（popup 明细的来源）
    await trySendFloat(sw, tabId!, 'float:collapse')
    await expect
      .poll(() => unreadOf(sender), { timeout: 30_000, message: '收起后跑完，该记一条未读' })
      .toHaveLength(1)

    // 展开看一眼：这条未读被就地标掉
    await trySendFloat(sw, tabId!, 'float:open')
    await expect.poll(() => unreadOf(sender), { timeout: 10_000 }).toEqual([])

    await sender.close()
    await page.close()
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

  test('关掉标签页：任务就地中止、半截照样落盘（带「已中断」）、不记「已完成」', async () => {
    const sender = await openMessengerPage(context!, extensionId)
    interface Snapshot {
      running: Array<{ conversationId: string }>
      items: Array<{ conversationId: string }>
    }
    /** 问 SW 要一份通知快照（进行中 + 已发生的） */
    const ask = async (): Promise<Snapshot | undefined> => {
      const res = (await sender.evaluate(
        async () => await chrome.runtime.sendMessage({ kind: 'notify:list' }),
      )) as { ok: boolean; data?: Snapshot } | undefined
      return res?.ok ? res.data : undefined
    }

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

    // 生成已开始（stub 收到请求，此刻正卡在它的延时里）
    const before = stub.stub.hits.length
    await expect.poll(() => stub.stub.hits.length, { timeout: 30_000 }).toBeGreaterThan(before)
    const started = await ask()
    const conversationId = started?.running[0]?.conversationId
    expect(conversationId, '生成中应能在快照里看到').toBeTruthy()

    // 关掉这个标签页 = 那条会话的现场没了 → 任务应当被就地中止（否则它在 offscreen 里跑完，
    // 用户既看不到结果、也没处按停止）
    await page.close()
    await expect
      .poll(async () => (await ask())?.running.length ?? -1, {
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

    // 这是用户自己关的，不该再给他记一条「对话已完成」（留一点时间让收尾落库 / 广播跑完）
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const after = await ask()
    expect(
      after?.items.some((n) => n.conversationId === conversationId),
      '自己关的页面不该收到完成通知',
    ).toBe(false)

    stub.setOptions({ delayMs: 6_000, holdAfterFirstChunkMs: 0 }) // 恢复默认节奏
    await sender.close()
  })

  test('会话被删：指向它的通知一并清掉', async () => {
    const sender = await openMessengerPage(context!, extensionId)
    interface Snapshot {
      running: Array<{ conversationId: string }>
      items: Array<{ conversationId: string; host?: string }>
    }
    const ask = async (): Promise<Snapshot | undefined> => {
      const res = (await sender.evaluate(
        async () => await chrome.runtime.sendMessage({ kind: 'notify:list' }),
      )) as { ok: boolean; data?: Snapshot } | undefined
      return res?.ok ? res.data : undefined
    }

    // 清场：前面几条用例也留下过未读通知，这里要的是「只有本条会话那一条」的干净起点
    await sender.evaluate(async () => await chrome.runtime.sendMessage({ kind: 'notify:drop', all: true }))
    // 配模型（独立做一遍，免得这条用例单独跑时依赖前面用例的副作用）
    const cfgPage = await context!.newPage()
    await cfgPage.goto(`chrome-extension://${extensionId}/workbench.html`)
    await cfgPage.evaluate(
      async (cfg) => {
        const api = (
          window as unknown as {
            api: {
              model: { save: (c: unknown) => Promise<{ id: string }>; setActive: (id: string) => Promise<void> }
            }
          }
        ).api
        const p = await api.model.save(cfg)
        await api.model.setActive(p.id)
      },
      { name: 'stub', baseUrl: stub.stub.baseUrl, apiKey: 'sk-stub', model: 'stub-model' },
    )
    await cfgPage.close()

    const page = await context!.newPage()
    await page.goto(probeUrl)
    const [tabId] = await tabIdsOf(sw, probeUrl)
    await expect.poll(() => trySendFloat(sw, tabId!, 'float:open'), { timeout: 15_000 }).toBe(true)
    const box = (await waitForPanelFrame(page)).getByRole('textbox').first()
    await box.fill('删除我') // 用一条独有的文本，好在工作台列表里认准这条（自动命名取首句）
    await box.press('Enter')
    // 收起 = 没人在看它 → 跑完会记一条未读通知
    await trySendFloat(sw, tabId!, 'float:collapse')

    await expect
      .poll(async () => (await ask())?.items.length ?? 0, {
        timeout: 30_000,
        message: '跑完没人在看，该记一条通知',
      })
      .toBe(1)
    // 通知里要能认出「是哪条对话」：站点名从标签页现查（取不到就只剩一句「对话已完成」）
    expect((await ask())?.items[0]?.host, '通知要带站点名').toBe('127.0.0.1')
    // 任务已跑完、只是没人看：角标不亮 —— 它只报脚本运行数，会话的事与它无关
    await expectNoScriptBadge(sw, tabId!)

    // 关掉标签页：任务其实已经跑完，这一步只是解绑归属 —— 会话变成「没被使用」才允许删
    await page.close()
    await expect.poll(async () => (await ask())?.running.length ?? -1).toBe(0)

    // 在工作台里删掉这条会话
    const workbench = await context!.newPage()
    await workbench.goto(`chrome-extension://${extensionId}/workbench.html#/sessions`)
    const row = workbench.locator('li').filter({ hasText: '删除我' }).first()
    await row.hover()
    await row.locator('[aria-label="会话操作"]').click()
    await workbench.getByRole('menuitem', { name: '删除', exact: true }).click()
    // 删除要先过一道确认框（取消 / 删除）
    await workbench
      .getByRole('dialog')
      .getByRole('button', { name: '删除', exact: true })
      .click()

    // 先确认删除本身生效了（否则下面的断言分不清「没删掉」与「删掉了但通知没清」）
    await expect
      .poll(
        async () =>
          await workbench.evaluate(
            async () =>
              (
                await (
                  window as unknown as {
                    api: { conversation: { list: () => Promise<Array<{ title: string }>> } }
                  }
                ).api.conversation.list()
              ).some((c) => c.title.includes('删除我')),
          ),
        { timeout: 10_000, message: '这条会话该被删掉' },
      )
      .toBe(false)

    // 通知要跟着走：不清的话，弹层里会留一条点不开的通知（会话都没了，点开也没有落点）
    await expect
      .poll(async () => (await ask())?.items.length ?? -1, {
        timeout: 10_000,
        message: '会话删了，通知也该没',
      })
      .toBe(0)
    // 这里验收尾干净：新开的标签页不该带上任何计数 —— 角标一律按标签页设，若哪里留了一个全局
    // 兜底值，每个新标签页都会自动带上它（本 spec 一个用户脚本都没装，所以这一页不该有数字）。
    const fresh = await context!.newPage()
    await fresh.goto(probeUrl)
    const [freshTabId] = await tabIdsOf(sw, probeUrl)
    expect(freshTabId, '新探针页的 tabId 应能反查到').toBeGreaterThan(0)
    await expectNoScriptBadge(sw, freshTabId!)
    await fresh.close()

    await workbench.close()
    await sender.close()
  })

  // ⚠️ 这条**在无头下测不了**，故 skip（逻辑留着，环境支持时解开即可）。
  //
  // 内容脚本的判据是 `document.visibilityState`，而无头 Chromium 不模拟标签页可见性 ——
  // 实测：新开多个 tab 全程都是 `visible`，`bringToFront()` 也不变；想从浏览器层
  // 强制也不行（CDP 的 `Emulation.setPageVisibilityOverride` 在此版本不存在，
  // `Page.setWebLifecycleState({state:'frozen'})` 执行成功但 `visibilityState` 仍是 visible）；
  // 从页面侧伪装同样不行 —— `Object.defineProperty(document, ...)` 改的是 MAIN world，
  // 内容脚本在 isolated world 读到的还是真实值（只有 DOM 事件能跨 world）。
  //
  // 所以这条由手测覆盖：展开浮层 → 切到别的标签页（这时收尾该记一条未读）→ 切回来（该标已读）。
  test.skip('切走标签页 = 用户没在看：跑完要记一条未读，切回来就标已读', async () => {
    // 发送端用 popup 页（它不连「在看」端口，不会干扰判据）
    const sender = await openMessengerPage(context!, extensionId)
    const push = (msg: Record<string, unknown>): Promise<unknown> =>
      sender.evaluate((m) => {
        void chrome.runtime.sendMessage(m).catch(() => {})
      }, msg)

    const page = await context!.newPage()
    await page.goto(probeUrl) // 最后打开 → 它是当前激活页
    const [tabId] = await tabIdsOf(sw, probeUrl)
    // 会话归属：假会话也得认领这个标签页，通知里才带得上站点名、判「在看」也有落点
    await bindConversations(page, tabId!, ['e2e-visibility'])

    // 对话框展开着、人也在这一页 → 「在看」
    await expect.poll(() => trySendFloat(sw, tabId!, 'float:open'), { timeout: 15_000 }).toBe(true)
    await waitForPanelFrame(page)

    // 切到别的标签页 = 页面不可见。
    // 这里直接把页面侧的判据伪造出来：**无头 Chromium 不模拟标签页可见性**（实测多个 tab 全程
    // 都是 visible，bringToFront 也不变），而这把要验的是「content script 读到 hidden 之后会不会
    // 把『在看』端口断掉」—— 浏览器何时给 hidden 是平台行为，不归我们测。
    const setVisible = (state: 'hidden' | 'visible', target: Page) =>
      target.evaluate((s) => {
        Object.defineProperty(document, 'visibilityState', { get: () => s, configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
      }, state)

    await setVisible('hidden', page)
    await push({ kind: 'chat:running', conversationId: 'e2e-visibility' })
    await push({ kind: 'chat:finished', conversationId: 'e2e-visibility' })
    await expect
      .poll(() => unreadOf(sender), { timeout: 10_000, message: '看不见了，跑完就该记一条' })
      .toEqual(['e2e-visibility'])

    await setVisible('visible', page)
    await expect
      .poll(() => unreadOf(sender), { timeout: 10_000, message: '回来看见就标已读' })
      .toEqual([])

    await sender.close()
    await page.close()
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
