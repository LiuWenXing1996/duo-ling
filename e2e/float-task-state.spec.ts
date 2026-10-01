// 任务状态外显的端测：对话框收起期间「在跑 / 跑完了」得有提示。
//
// 提示位只有图标角标（真实消息路径：扩展页 → SW 旁听 chat:running / chat:finished →
// chrome.action）：**在跑时报数，跑完即熄灭** —— 角标只数「正在发生的事」，跑完没看那条不进角标，
// 只留在悬停文案与 popup 里。
//
// **角标按标签页各算各的**：只报**这个标签页**上正在跑的条数，没有在跑的就不亮。归属两条路 ——
// 进行中的会话经 conversation-tab-map 反查所属标签页，未读通知自带 `tabId`（只喂悬停文案）；
// 一个标签页只归属一条会话（见 conversation-tab-map）。故读 / 断言一律要指明是哪一页
// （`chrome.action.getBadgeText({ tabId })` / `getTitle({ tabId })`）。
//
// 另有一条守「对话框的显隐」：页面里平时不注入任何 DOM，收到 float:open 才挂出来并连上
// 「在看」端口（`duoling:panel-open`），收起又把端口断掉。
//
// 页面内没有可点的入口（对话框平时不在页面里），故打开 / 收起一律走那两条定向消息 ——
// 与 popup 的按钮、页面右键菜单、对话框顶栏那颗「收起」是同一套契约（发送方那侧的行为由
// PopupPanel 的组件测试覆盖）。无头下也没有「在 iframe 里发消息」那条路，见 smoke.spec.ts
// 头注释。
//
// 推假会话的那几条要先给它认领一个标签页（否则没有可报数的落点）：绑定直接写 convByTab
// （duoling-app 库的键），见 bindConversations。绑定**怎么建立**由 conversation-tab-map 单测与
// chat-stub 端测覆盖，这里只借它把状态推上来 —— 库名 / store / 键名改动时与本 spec 一起改。
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

test.describe.serial('任务状态外显（图标角标 + 对话框显隐）', () => {
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

  /** 某个标签页的图标角标文字（空串 = 没亮）。角标按标签页各算各的，故必须指明是哪一页 */
  const badge = (tabId: number): Promise<string> =>
    sw.evaluate(async (id) => await chrome.action.getBadgeText({ tabId: id }), tabId)

  /** 某个标签页的图标悬停文案（空串 = 已恢复默认） */
  const title = (tabId: number): Promise<string> =>
    sw.evaluate(async (id) => await chrome.action.getTitle({ tabId: id }), tabId)

  /**
   * 从扩展页推一条 offscreen 推送（chat:running / chat:finished）。
   * 不能从 SW 自发：runtime 消息不回环到发送者自身上下文（见 extension.ts 的说明）。
   * 没有接收方响应这条消息（SW 只旁听、不 sendResponse），故吞掉可能的 reject。
   */
  const pushOffscreen = (msg: Record<string, unknown>): Promise<unknown> =>
    messenger.evaluate((m) => {
      void chrome.runtime.sendMessage(m).catch(() => {})
    }, msg)

  test('角标：按标签页各算各的（只数在跑的），不串到别的标签页', async () => {
    const c1 = 'e2e-count-1'
    const c2 = 'e2e-count-2'

    // 角标按标签页归属：假会话也得先认领一个标签页，否则它没有可报数的落点。
    // 两条假会话分认两页 —— 一个标签页只归属一条会话（convByTab 是 tab → 单条会话），
    // 正好用两页来验「各报各的、互不串页」。
    const page = await context!.newPage()
    await page.goto(probeUrl)
    const [msgTabId] = await tabIdsOf(sw, messenger.url())
    const [probeTabId] = await tabIdsOf(sw, probeUrl)
    expect(msgTabId, 'messenger 页的 tabId 应能反查到').toBeGreaterThan(0)
    expect(probeTabId, '探针页的 tabId 应能反查到').toBeGreaterThan(0)
    await bindConversations(messenger, msgTabId!, [c1])
    await bindConversations(page, probeTabId!, [c2])

    await expect.poll(() => badge(msgTabId!), { message: '起手不该有角标' }).toBe('')
    await expect.poll(() => badge(probeTabId!)).toBe('')
    expect(await title(msgTabId!)).toBe('')

    // c1 在跑 → 只落在它自己那一页
    await pushOffscreen({ kind: 'chat:running', conversationId: c1 })
    await expect.poll(() => badge(msgTabId!), { message: '在跑的会话认领了这页' }).toBe('1')
    expect(await title(msgTabId!), '悬停文案要说清在跑什么').toBe('进行中 1')
    expect(await badge(probeTabId!), '别的标签页不该跟着报数').toBe('')

    // c2 在跑 → 两页各报各的 1
    await pushOffscreen({ kind: 'chat:running', conversationId: c2 })
    await expect.poll(() => badge(probeTabId!)).toBe('1')
    await expect.poll(() => title(probeTabId!)).toBe('进行中 1')
    await expect.poll(() => badge(msgTabId!)).toBe('1')

    // c1 跑完没人在看 → 转成那页的未读：**角标随之熄灭**（它只数在跑的），那条信息挪进悬停文案
    await pushOffscreen({ kind: 'chat:finished', conversationId: c1 })
    await expect.poll(() => title(msgTabId!), { message: '跑完没人在看，该转成未读' }).toBe('已完成 1')
    await expect.poll(() => badge(msgTabId!), { message: '跑完没看不再点亮角标' }).toBe('')
    await expect.poll(() => title(probeTabId!), { message: '另一页不受影响' }).toBe('进行中 1')
    expect(await badge(probeTabId!), '另一页照旧在跑，角标不该被牵连').toBe('1')

    // 全部已读：通知中心是全局的一份，读掉就是读掉 → 那页的悬停文案清空（角标本就不报未读）
    await messenger.evaluate(async () => await chrome.runtime.sendMessage({ kind: 'notify:readAll' }))
    await expect.poll(() => title(msgTabId!), { message: '读过就该从文案里消失' }).toBe('')
    await expect.poll(() => badge(msgTabId!)).toBe('')
    await pushOffscreen({ kind: 'chat:finished', conversationId: c2 })
    await messenger.evaluate(async () => await chrome.runtime.sendMessage({ kind: 'notify:readAll' }))
    await expect.poll(() => badge(probeTabId!), { message: '在跑的那条一收尾就该熄灭' }).toBe('')
    await expect.poll(() => title(probeTabId!)).toBe('')

    await page.close()
  })

  test('popup：通知区给出明细，「全部已读」清掉悬停文案', async () => {
    const id = extensionIdFromServiceWorker(sw)
    // 清场后造一条：一个假会话跑完、没人看。假会话要先认领一个标签页，悬停文案才有落点
    await messenger.evaluate(async () => await chrome.runtime.sendMessage({ kind: 'notify:readAll' }))
    const [msgTabId] = await tabIdsOf(sw, messenger.url())
    expect(msgTabId, 'messenger 页的 tabId 应能反查到').toBeGreaterThan(0)
    await bindConversations(messenger, msgTabId!, ['e2e-popup-cid'])
    await pushOffscreen({ kind: 'chat:running', conversationId: 'e2e-popup-cid' })
    await pushOffscreen({ kind: 'chat:finished', conversationId: 'e2e-popup-cid' })
    // 跑完没看：角标不亮（只数在跑的），这条未读落在悬停文案里
    await expect.poll(() => title(msgTabId!)).toBe('已完成 1')
    await expect.poll(() => badge(msgTabId!)).toBe('')

    const popup = await context!.newPage()
    await popup.goto(`chrome-extension://${id}/popup.html`)
    await expect(popup.locator('[data-testid="popup-notifications"]')).toBeVisible()
    await expect(popup.locator('[data-testid="notify-item"]')).toHaveCount(1)

    await popup.locator('[data-testid="notify-read-all"]').click()
    await expect.poll(() => title(msgTabId!), { message: '在 popup 里读过，文案就该清掉' }).toBe('')
    // 无通知时整块不渲染（常态 popup 保持原样）
    await expect(popup.locator('[data-testid="popup-notifications"]')).toHaveCount(0)
    await popup.close()
  })

  test('对话框：平时不注入，打开即连「在看」端口，收起又断', async () => {
    const page = await context!.newPage()
    await page.goto(probeUrl)
    const [tabId] = await tabIdsOf(sw, probeUrl)
    expect(tabId, '探针页的 tabId 应能反查到').toBeGreaterThan(0)
    // 会话归属：本用例推的是假会话，得让它先认领这个标签页，角标才有落点
    await bindConversations(page, tabId!, [CID])

    // 起手：页面里连根节点都没有 —— content script 只在收到 float:open 时才建
    await expect(page.locator('#duoling-float-root')).toHaveCount(0)

    // 造一条「在跑」：没人看着的时候，角标得亮着。
    // 用进行中而不是跑完未读 —— 打开浮层会把本页会话的未读标掉（用户回来就等于看到了），
    // 那条读过的通知收起后不会再亮；「还在跑」没有这个问题，收起时照旧要报。
    await pushOffscreen({ kind: 'chat:running', conversationId: CID })
    await expect.poll(() => badge(tabId!), { message: '没人看，角标该亮' }).toBe('1')

    // 打开（popup 的按钮与页面右键菜单发的就是这条消息）
    await expect
      .poll(() => trySendFloat(sw, tabId!, 'float:open'), { timeout: 15_000 })
      .toBe(true)
    const panel = await waitForPanelFrame(page)
    await expect(page.locator('#duoling-float-root .dl-float-container')).toHaveClass(/open/)
    await expect.poll(() => badge(tabId!), { message: '人正看着对话界面，角标该收起' }).toBe('')

    // 收起：点对话框顶栏那颗**真按钮** —— 它是这条链路里唯一跨源的一步（按钮在 iframe 里、
    // 容器在父页），拿「发一条消息」代过就只剩替身了。
    await panel.getByLabel('收起').click()
    await expect(page.locator('#duoling-float-root .dl-float-container')).not.toHaveClass(/open/)
    // 只藏不销毁：容器仍在 DOM 里（iframe、草稿、滚动位置都留着，再打开就是原状态）
    await expect(page.locator('#duoling-float-root')).toHaveCount(1)
    await expect
      .poll(() => badge(tabId!), { message: '没人看了，还在跑的那条该重新报出来' })
      .toBe('1')

    await pushOffscreen({ kind: 'chat:finished', conversationId: CID }) // 别把假会话留在「进行中」
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
 * 让若干会话认领一个标签页（直接写 duoling-app 库的 `convByTab` 键）。
 *
 * 角标按标签页归属：进行中的会话要靠 conversation-tab-map 反查所属标签页才算得出数字。本 spec 里
 * 有一组用例推的是不存在的假会话 id（只为验 SW 侧的分发），走不到「在面板里发消息」那条建立归属的
 * 真实路径，故在这里替它们认领一个。一个标签页只归属一条会话（见 conversation-tab-map），同一个
 * tabId 上后写的会覆盖先写的 —— 要验多条并行，就得各自认领一个标签页。
 *
 * 库名 / store / 键名改动时与本 spec 一起改。
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

  /** 某个标签页的图标角标文字（空串 = 没亮）—— 角标按标签页各算各的，故必须指明是哪一页 */
  const badge = (tabId: number): Promise<string> =>
    sw.evaluate(async (id) => await chrome.action.getBadgeText({ tabId: id }), tabId)

  /** 某个标签页的图标悬停文案：角标只数在跑的，跑完没看要靠它才看得到 */
  const title = (tabId: number): Promise<string> =>
    sw.evaluate(async (id) => await chrome.action.getTitle({ tabId: id }), tabId)

  test('发消息 → 收起即亮角标 → 跑完熄灭（未读只进悬停文案） → 展开清零', async () => {
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

    // 生成已开始（stub 收到请求）而对话框开着：进度就在面板里，角标不该来打扰
    await expect.poll(() => stub.stub.hits.length, { timeout: 30_000 }).toBeGreaterThan(0)
    expect(await badge(tabId!), '对话框开着时不该亮角标').toBe('')

    // 收起：进行中角标 1 —— 这一条正是「收起那一刻要按当前状态重算」
    await trySendFloat(sw, tabId!, 'float:collapse')
    await expect.poll(() => title(tabId!), { timeout: 10_000 }).toBe('进行中 1')
    await expect.poll(() => badge(tabId!), { timeout: 10_000 }).toBe('1')

    // 生成收尾（收起态下没人看）：转成一条未读 —— **角标随之熄灭**（只数在跑的），口径挪进悬停文案
    await expect
      .poll(() => title(tabId!), { timeout: 30_000, message: '跑完没人在看，该转成未读' })
      .toBe('已完成 1')
    await expect.poll(() => badge(tabId!), { timeout: 10_000, message: '跑完没看不再点亮角标' }).toBe('')

    // 展开看一眼：这条未读被就地标掉，悬停文案跟着清空
    await trySendFloat(sw, tabId!, 'float:open')
    await expect.poll(() => title(tabId!), { timeout: 10_000 }).toBe('')
    await expect.poll(() => badge(tabId!), { timeout: 10_000 }).toBe('')

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

  test('会话被删：指向它的通知一并清掉，角标跟着归零', async () => {
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
    // 任务已跑完、只是没人看：角标不亮，这条未读只落在悬停文案里
    await expect.poll(() => title(tabId!), { timeout: 10_000 }).toBe('已完成 1')
    await expect.poll(() => badge(tabId!), { timeout: 10_000 }).toBe('')

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

    // 通知要跟着走：不清的话，弹层里会留一条点不开的通知（角标只报在跑的，本来就没挂着它）
    await expect
      .poll(async () => (await ask())?.items.length ?? -1, {
        timeout: 10_000,
        message: '会话删了，通知也该没',
      })
      .toBe(0)
    // 那个标签页已经关了（会话要先「没人用」才允许删），它的角标与文案随标签页一起消失。这里验收尾
    // 干净：新开的标签页不该继承任何数字 —— 全局兜底值若留着，每个新标签页都会自动带上别人的数。
    const fresh = await context!.newPage()
    await fresh.goto(probeUrl)
    const [freshTabId] = await tabIdsOf(sw, probeUrl)
    expect(freshTabId, '新探针页的 tabId 应能反查到').toBeGreaterThan(0)
    await expect
      .poll(() => badge(freshTabId!), { timeout: 10_000, message: '新标签页不该带角标' })
      .toBe('')
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
    const [tabId] = await tabIdsOf(sw, probeUrl)
    // 会话归属：假会话也得认领这个标签页，角标才有报数的落点
    await bindConversations(page, tabId!, ['e2e-visibility'])

    // 对话框展开着、人也在这一页 → 「在看」，一条在跑也不打扰
    await expect.poll(() => trySendFloat(sw, tabId!, 'float:open'), { timeout: 15_000 }).toBe(true)
    await waitForPanelFrame(page)
    await push({ kind: 'chat:running', conversationId: 'e2e-visibility' })
    await expect.poll(() => badge(tabId!), { timeout: 10_000, message: '人正看着，不该亮' }).toBe('')

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
    await expect.poll(() => badge(tabId!), { timeout: 10_000, message: '切走看不见了，要提示' }).toBe('1')

    await setVisible('visible', page)
    await expect.poll(() => badge(tabId!), { timeout: 10_000, message: '回来看见了就清掉' }).toBe('')

    await push({ kind: 'chat:finished', conversationId: 'e2e-visibility' }) // 别把假会话留在「进行中」
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
