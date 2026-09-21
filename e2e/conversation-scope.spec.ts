// 会话归属按标签页（README 手测 #19 的可自动化子集）。
//
// 为什么以前做不了：「会话」只有走完一次 `chat:start` 才落库，而它要模型 ⇒ 只能人肉手测。
// 现在用 `e2e/model-stub.ts` 的本地假模型顶替真模型，这条链路能在无头 CI 上跑完，于是：
//   · 打开面板不产生会话（没发消息就没有会话）；
//   · 在 A 发一条 ⇒ 会话归 A，新开的 B 看不到它（归属）；
//   · 刷新 A ⇒ 会话不丢、不换、也不新建；
//   · 删除门：正被开着的标签页占用的会话删不掉（拦截在工作台「会话历史」的 onDelete 里）。
// 仍留人手的两条（见 README #19）：生成不中断（要真模型的长回复）、跨窗口跳转的体感。
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extensionIdFromServiceWorker, getServiceWorker, launchExtensionContext } from './extension'
import { startModelStub } from './model-stub'

/** 浮层对话页（`installWindowApi()` 在这里挂上 window.api） */
const APP_PAGE = 'floatpanel.html'

/** 页面内取会话数（读侧直连 IndexedDB，见 window-api 的说明） */
async function convCount(page: Page): Promise<number> {
  return await page.evaluate(async () =>
    ((await (window as unknown as { api: { conversation: { list: () => Promise<unknown[]> } } }).api.conversation.list()) ?? [])
      .length,
  )
}

test.describe.serial('会话归属按标签页', () => {
  let context: BrowserContext | undefined
  let profileDir = ''
  let stub: Awaited<ReturnType<typeof startModelStub>>
  let extensionId = ''
  /** A 页留着不关：删除门那条需要「那个标签页还开着」 */
  let pageA: Page | undefined

  /** 开一个浮层页（= 一个标签页） */
  async function openApp(): Promise<Page> {
    const page = await context!.newPage()
    await page.goto(`chrome-extension://${extensionId}/${APP_PAGE}`)
    return page
  }

  /** 在浮层里发一句、等 stub 的回复出现 */
  async function send(page: Page, text: string): Promise<void> {
    const box = page.getByRole('textbox').first()
    await box.fill(text)
    await box.press('Enter')
    await expect(page.getByText(new RegExp(`stub 回复：${text}`))).toBeVisible({ timeout: 25_000 })
  }

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-scope-e2e-'))
    stub = await startModelStub()
    context = await launchExtensionContext(profileDir)
    extensionId = extensionIdFromServiceWorker(await getServiceWorker(context))

    // 把模型指到 stub（设置页保存模型走的就是这两个方法）
    const page = await openApp()
    await page.evaluate(
      async (cfg) => {
        const api = (
          window as unknown as {
            api: { model: { save: (c: unknown) => Promise<{ id: string }>; setActive: (id: string) => Promise<void> } }
          }
        ).api
        const p = await api.model.save(cfg)
        await api.model.setActive(p.id)
      },
      { name: 'stub', baseUrl: stub.stub.baseUrl, apiKey: 'sk-stub', model: 'stub-model' },
    )
    await page.close()
  })

  test.afterAll(async () => {
    const withTimeout = (p: Promise<unknown> | undefined, ms: number) =>
      p ? Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve()
    try { await withTimeout(context?.close(), 30_000) } catch { /* 忽略 */ }
    try {
      stub.server.closeAllConnections()
      await withTimeout(new Promise<void>((r) => stub.server.close(() => r())), 5_000)
    } catch { /* 忽略 */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })

  test('打开面板不产生会话（没发消息就没有会话）', async () => {
    const a = await openApp()
    const b = await openApp()
    expect(await convCount(a), '只是打开面板不该建出空会话').toBe(0)
    await a.close()
    await b.close()
  })

  test('在 A 发一条：会话归 A，新标签页 B 看不到它', async () => {
    pageA = await openApp()
    await send(pageA, '甲')
    expect(await convCount(pageA), '发完一句应产生 1 条会话').toBe(1)

    const b = await openApp()
    expect(await convCount(b), '全局仍只有 1 条').toBe(1)
    await expect(b.getByText(/stub 回复：甲/), 'B 不该看到 A 的会话').toHaveCount(0)
    await b.close()
  })

  test('刷新 A：会话不丢、不换、也不新建', async () => {
    const a = pageA!
    await a.reload()
    await expect(a.getByText(/stub 回复：甲/), '刷新后原会话还在').toBeVisible({ timeout: 20_000 })
    expect(await convCount(a), '刷新不该新建会话').toBe(1)
  })

  // —— 删除门：**当前 harness 测不到，留了原因的 skip** ——
  //
  // 试过并定位到根因（2026-09-21）：拦截判据是「归属映射里有这条会话 + 那个标签页还开着」
  // （`conversation-tab-map.getActiveTabBindings`），而归属只在 `currentTabId != null` 时才写
  // （`use-global-conversation.ensureActiveConversation`）；`tab:identify` 的实现是
  // `sender.tab?.id ?? null`，源码注释明确写了「**扩展页发的消息本就没有 tab**」。
  // ⇒ 本 spec 里独立打开的 `floatpanel.html` 标签页拿不到 tabId、不写归属，门自然不触发
  //   （实测弹的是普通确认框「删除会话「甲」」而不是拦截框）。
  // 要自动验它，得让浮层跑在**页面内的 iframe** 里（真实产品的路径：content script 挂 iframe，
  // 消息经它转发 → 有 sender.tab），而 smoke 里已注明「无头下没有 FAB 点击这条路径」。
  test.skip('删除门：正被开着的标签页占用的会话删不掉（需要页面内 iframe 路径，见上方注释）', async () => {
    /* 保留位置与理由；等 harness 支持页面内浮层后再填 */
  })
})
