// 会话归属按标签页的端测。
//
// 为什么以前做不了：「会话」只有走完一次 `chat:start` 才落库，而它要模型 ⇒ 只能人肉手测。
// 现在用 `scripts/model-stub.mts` 的本地假模型顶替真模型，这条链路能在无头 CI 上跑完，于是：
//   · 打开面板不产生会话（没发消息就没有会话）；
//   · 在 A 发一条 ⇒ 会话归 A，新开的 B 看不到它（归属）；
//   · 刷新 A ⇒ 会话不丢、不换、也不新建；
//   · 删除门：正被开着的标签页占用的会话删不掉（拦截在工作台「会话历史」的 onDelete 里）。
// 仍留人手的两条（见 README #19）：生成不中断（要真模型的长回复）、跨窗口跳转的体感。
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extensionIdFromServiceWorker,
  getServiceWorker,
  launchExtensionContext,
  openChatPage,
} from './extension'
import { saveStubModel } from './model-config'
import { startModelStub } from '../scripts/model-stub.mts'
import { countConversations } from './chat-db'

/** 页面内取会话数：直接读会话库（读侧本来就是裸 IndexedDB） */
const convCount = (page: Page): Promise<number> => countConversations(page)

test.describe.serial('会话归属按标签页', () => {
  let context: BrowserContext | undefined
  let profileDir = ''
  let stub: Awaited<ReturnType<typeof startModelStub>>
  let extensionId = ''
  /** A 页留着不关：删除门那条需要「那个标签页还开着」 */
  let pageA: Page | undefined

  async function openApp(): Promise<Page> {
    return openChatPage(context!, extensionId)
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

    // 模型只能在设置页配（浮层没有设置入口）。工作台与浮层同源共享存储，后面 openApp 开的面板直接可用。
    const setup = await context.newPage()
    await setup.goto(`chrome-extension://${extensionId}/workbench.html`)
    await saveStubModel(setup, { baseUrl: stub.stub.baseUrl })
    await setup.close()
  })

  test.afterAll(async () => {
    const withTimeout = (p: Promise<unknown> | undefined, ms: number) =>
      p ? Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve()
    try {
      await withTimeout(context?.close(), 30_000)
    } catch {
      /* 忽略 */
    }
    try {
      stub.server.closeAllConnections()
      await withTimeout(new Promise<void>((r) => stub.server.close(() => r())), 5_000)
    } catch {
      /* 忽略 */
    }
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
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

  // 归属已能由 `?tab=` 注入（门已具备触发条件），待补的是工作台「会话历史」里点删除那几步。
  test.skip('删除门：正被开着的标签页占用的会话删不掉（待补工作台的删除交互）', () => {})
})
