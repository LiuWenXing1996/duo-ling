// 任务状态外显的端测：浮层收起期间「在跑 / 跑完了」得有提示。
//
// 两个载体各验一段，都不依赖页面内的对话交互（无头下没有「点 FAB 再在 iframe 里发消息」
// 那条路，见 smoke.spec.ts 头注释）：
//   · 图标角标 —— 真实消息路径（扩展页 → SW 旁听 chat:running / chat:finished → chrome.action）：
//     进行中亮中性、收尾亮红点、浮层展开即清零、展开着不亮。
//   · 悬浮按钮 —— 真实 http 页加载 content script：UI 挂上即连常驻端口、SW 补推快照（idle），
//     此后收到 running / done 就换态（转圈 / 红点），展开浮层时收起。
//
// 悬浮按钮要「本 tab 有会话」才收得到状态（SW 用 conversationId 反查标签页，见
// conversation-tab-map 的 findTabsUsingConversation）。绑定这里直接写 convByTab
// （duoling-app 库的键）：绑定**怎么建立**由 conversation-tab-map 单测与 chat-stub 端测覆盖，
// 这里只借它把状态推上来 —— 库名 / store / 键名改动时与本 spec 一起改。
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

/** 假会话 id：状态推送只按它反查标签页，不需要真会话存在 */
const CID = 'e2e-task-state'

test.describe.serial('任务状态外显（角标 + 悬浮按钮）', () => {
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

  /** 扩展图标角标文字（空串 = 没亮） */
  const badge = (): Promise<string> => sw.evaluate(async () => await chrome.action.getBadgeText({}))

  /** 图标悬停文案（空串 = 已恢复默认） */
  const title = (): Promise<string> => sw.evaluate(async () => await chrome.action.getTitle({}))

  /**
   * 从扩展页推一条 offscreen 推送（chat:running / chat:finished）。
   * 不能从 SW 自发：runtime 消息不回环到发送者自身上下文（见 extension.ts 的说明）。
   * 没有接收方响应这条消息（SW 只旁听、不 sendResponse），故吞掉可能的 reject。
   */
  const pushOffscreen = (msg: Record<string, unknown>): Promise<unknown> =>
    messenger.evaluate((m) => {
      void chrome.runtime.sendMessage(m).catch(() => {})
    }, msg)

  test('角标：纯数字计数（进行中 + 未读完成），展开即清、收起又回来', async () => {
    const c1 = 'e2e-count-1'
    const c2 = 'e2e-count-2'

    await expect.poll(badge, { message: '起手不该有角标' }).toBe('')
    expect(await title()).toBe('')

    // 一个在跑 → 1
    await pushOffscreen({ kind: 'chat:running', conversationId: c1 })
    await expect.poll(badge, { message: '一个在跑' }).toBe('1')
    expect(await title(), '悬停文案要说清在跑什么').toBe('进行中 1')

    // 两个在跑 → 2：数字会累加，这正是「全局那一份」该有的样子
    await pushOffscreen({ kind: 'chat:running', conversationId: c2 })
    await expect.poll(badge, { message: '两个在跑' }).toBe('2')
    await expect.poll(title).toBe('进行中 2')

    // 一个跑完没看 → 总数不变（进行中 1 + 未读 1），悬停文案分开报
    await pushOffscreen({ kind: 'chat:finished', conversationId: c1 })
    await expect.poll(title).toBe('进行中 1 · 已完成 1')
    await expect.poll(badge).toBe('2')

    // 都跑完 → 两条未读
    await pushOffscreen({ kind: 'chat:finished', conversationId: c2 })
    await expect.poll(title, { message: '两条未读' }).toBe('已完成 2')
    await expect.poll(badge).toBe('2')

    // 浮层展开（扩展页代连真端口）：角标先收起来 —— 用户正看着对话界面
    await messenger.evaluate(() => {
      ;(window as unknown as { __openPort?: chrome.runtime.Port }).__openPort = chrome.runtime.connect({
        name: 'duoling:panel-open',
      })
    })
    await expect.poll(badge, { message: '用户在看，角标该收起' }).toBe('')

    // 收起：角标回来 —— 那两条未读属于别的会话，而这个标签页没绑定任何会话，一条都没被读掉
    // （按会话标已读，不做全局清空）
    await messenger.evaluate(() => {
      ;(window as unknown as { __openPort?: chrome.runtime.Port }).__openPort?.disconnect()
    })
    await expect.poll(badge, { message: '别人的未读不该被读掉' }).toBe('2')

    // 超过 9 显示 9+
    for (let i = 0; i < 10; i++) {
      await pushOffscreen({ kind: 'chat:running', conversationId: `e2e-bulk-${i}` })
    }
    await expect.poll(title, { message: '悬停文案报真实数量' }).toBe('进行中 10 · 已完成 2')
    await expect.poll(badge, { message: '两位数换算成 9+' }).toBe('9+')

    // 全部已读：只清掉已完成那些，进行中的仍要报
    await messenger.evaluate(async () => await chrome.runtime.sendMessage({ kind: 'notify:readAll' }))
    await expect.poll(title).toBe('进行中 10')
    await expect.poll(badge, { message: '在跑的还没完，角标不该清零' }).toBe('9+')

    // 收尾 10 条 → 10 条未读；读过之后才真正清零
    for (let i = 0; i < 10; i++) {
      await pushOffscreen({ kind: 'chat:finished', conversationId: `e2e-bulk-${i}` })
    }
    await expect.poll(title).toBe('已完成 10')
    await messenger.evaluate(async () => await chrome.runtime.sendMessage({ kind: 'notify:readAll' }))
    await expect.poll(badge, { message: '都读过就清零' }).toBe('')
    await expect.poll(title).toBe('')
  })

  test('popup：通知区给出明细，「全部已读」把角标清零', async () => {
    const id = extensionIdFromServiceWorker(sw)
    // 清场后造一条：一个假会话跑完、没人看
    await messenger.evaluate(async () => await chrome.runtime.sendMessage({ kind: 'notify:readAll' }))
    await pushOffscreen({ kind: 'chat:running', conversationId: 'e2e-popup-cid' })
    await pushOffscreen({ kind: 'chat:finished', conversationId: 'e2e-popup-cid' })
    await expect.poll(badge).toBe('1')

    const popup = await context!.newPage()
    await popup.goto(`chrome-extension://${id}/popup.html`)
    await expect(popup.locator('[data-testid="popup-notifications"]')).toBeVisible()
    await expect(popup.locator('[data-testid="notify-item"]')).toHaveCount(1)

    await popup.locator('[data-testid="notify-read-all"]').click()
    await expect.poll(badge, { message: '在 popup 里读过，角标就该清零' }).toBe('')
    // 无通知时整块不渲染（常态 popup 保持原样）
    await expect(popup.locator('[data-testid="popup-notifications"]')).toHaveCount(0)
    await popup.close()
  })

  test('悬浮按钮：快照对齐、跑起来转圈、跑完亮红点、展开即收起', async () => {
    const page = await context!.newPage()
    await page.goto(probeUrl)

    // UI 挂上就连任务状态端口 → SW 立刻补推一次当前状态；能读到 idle 就说明这条通道通了
    // （初始脚本不写该属性，只有收到推送才写）
    const fab = page.locator('#duoling-fab-root .dl-fab-container')
    await expect(fab).toHaveAttribute('data-task', 'idle', { timeout: 15_000 })

    // 本 tab ↔ 会话：没有它，SW 反查不到标签页，状态无处可推
    const tabId = await sw.evaluate(
      async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id ?? -1,
      probeUrl,
    )
    expect(tabId, '探针页的 tabId 应能反查到').toBeGreaterThan(0)
    await bindConversationToTab(messenger, tabId, CID)

    await pushOffscreen({ kind: 'chat:running', conversationId: CID })
    await expect(fab).toHaveAttribute('data-task', 'running', { timeout: 15_000 })

    await pushOffscreen({ kind: 'chat:finished', conversationId: CID })
    await expect(fab).toHaveAttribute('data-task', 'done', { timeout: 15_000 })

    // 展开浮层：进度与结果都在面板里，按钮上的状态收起
    await page.locator('#duoling-fab-root .dl-fab').click()
    await expect(fab).toHaveAttribute('data-task', 'idle', { timeout: 15_000 })

    await page.close()
  })
})

/** 往 duoling-app 的 kv 写 convByTab（等价于 conversation-tab-map 的 bindTabToConversation） */
async function bindConversationToTab(page: Page, tabId: number, conversationId: string): Promise<void> {
  await page.evaluate(
    async ({ tabId, conversationId }) => {
      const DB = 'duoling-app'
      const STORE = 'kv'
      const KEY = 'convByTab'
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, 1)
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) {
            req.result.createObjectStore(STORE, { keyPath: 'key' })
          }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const prev = await new Promise<{ value?: unknown } | undefined>((resolve, reject) => {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY)
        r.onsuccess = () => resolve(r.result as { value?: unknown } | undefined)
        r.onerror = () => reject(r.error)
      })
      const value = { ...((prev?.value as Record<string, string> | undefined) ?? {}), [String(tabId)]: conversationId }
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put({ key: KEY, value })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    },
    { tabId, conversationId },
  )
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

  const badge = (): Promise<string> => sw.evaluate(async () => await chrome.action.getBadgeText({}))

  test('发消息 → 收起 = 转圈 + 进行中角标 → 完成 = 红点 + 完成角标 → 展开双清', async () => {
    const page = await context!.newPage()
    await page.goto(probeUrl)
    const fab = page.locator('#duoling-fab-root .dl-fab-container')
    const fabButton = page.locator('#duoling-fab-root .dl-fab')
    await expect(fabButton).toBeVisible()

    // 真人路径：点开浮层 → 在面板里配模型（`window.api` 只有浮层这一侧装，popup 是纯配置面板）
    // → 填字回车。会话归属也由这条路径建立，不用测试代写 convByTab。
    await fabButton.click()
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

    // 生成已开始（stub 收到请求）而浮层开着：进度就在面板里，按钮与角标都不该来打扰
    await expect.poll(() => stub.stub.hits.length, { timeout: 30_000 }).toBeGreaterThan(0)
    await expect(fab).toHaveAttribute('data-task', 'idle')
    expect(await badge(), '浮层开着时不该亮角标').toBe('')

    // 收起：按钮转圈 + 角标 1（一个在跑）—— 这一条正是「收起那一刻要按当前状态重算」
    await fabButton.click()
    await expect(fab).toHaveAttribute('data-task', 'running', { timeout: 10_000 })
    await expect.poll(badge, { timeout: 10_000 }).toBe('1')

    // 生成收尾（收起态下没人看）：按钮红点 + 角标仍是 1（一个跑完没看）
    await expect(fab).toHaveAttribute('data-task', 'done', { timeout: 30_000 })
    await expect.poll(badge, { timeout: 10_000 }).toBe('1')

    // 展开看一眼：两处都清
    await fabButton.click()
    await expect(fab).toHaveAttribute('data-task', 'idle', { timeout: 10_000 })
    await expect.poll(badge, { timeout: 10_000 }).toBe('')

    await page.close()
  })

  test('两个同址标签页：状态只推给绑定了这条会话的那个', async () => {
    const tabA = await context!.newPage()
    await tabA.goto(probeUrl)
    const tabB = await context!.newPage()
    await tabB.goto(probeUrl)

    const fabA = tabA.locator('#duoling-fab-root .dl-fab-container')
    const fabB = tabB.locator('#duoling-fab-root .dl-fab-container')
    await expect(tabA.locator('#duoling-fab-root .dl-fab')).toBeVisible()
    await expect(tabB.locator('#duoling-fab-root .dl-fab')).toBeVisible()

    // 只在 A 发消息：B 全程只是「同一个地址的另一个标签页」，没有自己的会话
    const before = stub.stub.hits.length
    await tabA.locator('#duoling-fab-root .dl-fab').click()
    const panel = await waitForPanelFrame(tabA)
    const box = panel.getByRole('textbox').first()
    await box.fill('你好')
    await box.press('Enter')
    await expect.poll(() => stub.stub.hits.length).toBeGreaterThan(before)

    // A 收起 → 转圈；B 不该有任何状态（反查映射里没有它）
    await tabA.locator('#duoling-fab-root .dl-fab').click()
    await expect(fabA).toHaveAttribute('data-task', 'running', { timeout: 10_000 })
    await expect(fabB, '同一地址的另一个标签页不该收到这条会话的状态').toHaveAttribute('data-task', 'idle')

    await tabB.close()
    await tabA.close()
  })

  test('两页各有自己的会话：B 的「跑完没看」不会被 A 的新任务顶掉或点亮', async () => {
    const tabA = await context!.newPage()
    await tabA.goto(probeUrl)
    const tabB = await context!.newPage()
    await tabB.goto(probeUrl)

    const fabA = tabA.locator('#duoling-fab-root .dl-fab-container')
    const fabB = tabB.locator('#duoling-fab-root .dl-fab-container')
    const fabBtnA = tabA.locator('#duoling-fab-root .dl-fab')
    const fabBtnB = tabB.locator('#duoling-fab-root .dl-fab')
    await expect(fabBtnA).toBeVisible()
    await expect(fabBtnB).toBeVisible()

    // B 先聊一句并收起 → B 挂上自己的「跑完没看」（这是 B 的状态，与 A 无关）
    let before = stub.stub.hits.length
    await fabBtnB.click()
    const boxB = (await waitForPanelFrame(tabB)).getByRole('textbox').first()
    await boxB.fill('B 的问题')
    await boxB.press('Enter')
    await expect.poll(() => stub.stub.hits.length).toBeGreaterThan(before)
    await fabBtnB.click()
    await expect(fabB).toHaveAttribute('data-task', 'done', { timeout: 30_000 })

    // A 再跑一个：A 转圈，B 保持它自己的未读 —— 两个标签页各算各的，不互相顶替
    before = stub.stub.hits.length
    await fabBtnA.click()
    const boxA = (await waitForPanelFrame(tabA)).getByRole('textbox').first()
    await boxA.fill('A 的问题')
    await boxA.press('Enter')
    await expect.poll(() => stub.stub.hits.length).toBeGreaterThan(before)
    await fabBtnA.click()
    await expect(fabA).toHaveAttribute('data-task', 'running', { timeout: 10_000 })
    await expect(fabB, 'B 显示的是它自己的未读，不是 A 这次任务的').toHaveAttribute('data-task', 'done')

    // 通知里要能认出「是哪条对话」：站点名从标签页现查（取不到就只剩一句「对话已完成」）
    const popup = await context!.newPage()
    await popup.goto(`chrome-extension://${extensionId}/popup.html`)
    await expect(popup.locator('[data-testid="notify-item"]').first()).toContainText('127.0.0.1')
    await popup.close()

    await tabB.close()
    await tabA.close()
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
    await page.locator('#duoling-fab-root .dl-fab').click()
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

  test('会话被删：指向它的通知一并清掉，角标跟着归零', async () => {
    const sender = await openMessengerPage(context!, extensionId)
    interface Snapshot {
      running: Array<{ conversationId: string }>
      items: Array<{ conversationId: string }>
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
    const fabButton = page.locator('#duoling-fab-root .dl-fab')
    await fabButton.click()
    const box = (await waitForPanelFrame(page)).getByRole('textbox').first()
    await box.fill('删除我') // 用一条独有的文本，好在工作台列表里认准这条（自动命名取首句）
    await box.press('Enter')
    await fabButton.click() // 收起 = 没人在看它 → 跑完会记一条未读通知

    await expect
      .poll(async () => (await ask())?.items.length ?? 0, {
        timeout: 30_000,
        message: '跑完没人在看，该记一条通知',
      })
      .toBe(1)
    await expect.poll(badge, { timeout: 10_000 }).toBe('1')

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

    // 通知与角标都该跟着走：不清的话，弹层里会留一条点不开的通知，角标也一直挂着它
    await expect
      .poll(async () => (await ask())?.items.length ?? -1, {
        timeout: 10_000,
        message: '会话删了，通知也该没',
      })
      .toBe(0)
    await expect.poll(badge, { timeout: 10_000, message: '角标要归零' }).toBe('')

    await workbench.close()
    await sender.close()
  })

  // ⚠️ 这条**在无头下测不了**，故 skip（逻辑留着，环境支持时解开即可）。
  //
  // 内容脚本的判据是 `document.visibilityState`，而无头 Chromium 不模拟标签页可见性 ——
  // 2026-09-22 实测：新开多个 tab 全程都是 `visible`，`bringToFront()` 也不变；想从浏览器层
  // 强制也不行（CDP 的 `Emulation.setPageVisibilityOverride` 在此版本不存在，
  // `Page.setWebLifecycleState({state:'frozen'})` 执行成功但 `visibilityState` 仍是 visible）；
  // 从页面侧伪装同样不行 —— `Object.defineProperty(document, ...)` 改的是 MAIN world，
  // 内容脚本在 isolated world 读到的还是真实值（只有 DOM 事件能跨 world）。
  //
  // 所以这条由手测覆盖：展开浮层 → 切到别的标签页（角标该亮）→ 切回来（该清）。
  test.skip('切走标签页 = 用户没在看：该提示就提示，切回来就清', async () => {
    // 发送端用 popup 页（它不连「在看」端口，不会干扰判据）
    const sender = await openMessengerPage(context!, extensionId)
    const push = (msg: Record<string, unknown>): Promise<unknown> =>
      sender.evaluate((m) => {
        void chrome.runtime.sendMessage(m).catch(() => {})
      }, msg)

    const page = await context!.newPage()
    await page.goto(probeUrl) // 最后打开 → 它是当前激活页
    const fabButton = page.locator('#duoling-fab-root .dl-fab')
    await expect(fabButton).toBeVisible()

    // 浮层展开着、人也在这一页 → 「在看」，一条在跑也不打扰
    await fabButton.click()
    await waitForPanelFrame(page)
    await push({ kind: 'chat:running', conversationId: 'e2e-visibility' })
    await expect.poll(badge, { timeout: 10_000, message: '人正看着，不该亮' }).toBe('')

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
    await expect.poll(badge, { timeout: 10_000, message: '切走看不见了，要提示' }).toBe('1')

    await setVisible('visible', page)
    await expect.poll(badge, { timeout: 10_000, message: '回来看见了就清掉' }).toBe('')

    await push({ kind: 'chat:finished', conversationId: 'e2e-visibility' }) // 别把假会话留在「进行中」
    await sender.close()
    await page.close()
  })
})

/** 等浮层 iframe 出现（点开 FAB 后 content script 才去取 tabId、再给它设 src） */
async function waitForPanelFrame(page: Page): Promise<Frame> {
  for (let i = 0; i < 100; i++) {
    const frame = page.frames().find((f) => f.url().includes('floatpanel.html'))
    if (frame) return frame
    await page.waitForTimeout(200)
  }
  throw new Error('浮层 iframe 未出现：该站点可能拦了扩展 iframe，或这一下点击没生效')
}
