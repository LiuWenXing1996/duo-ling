import { test, expect, type BrowserContext, type Page, type Worker } from '@playwright/test'
import { saveStubModel } from './model-config'
import * as http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chatPageUrl,
  extensionIdFromServiceWorker,
  getServiceWorker,
  launchExtensionContext,
  openMessengerPage,
} from './extension'
import { startModelStub } from '../scripts/model-stub.mts'
import { readStoredMessages, type StoredMessage } from './chat-db'

test.describe.serial('任务状态外显（进行中登记）', () => {
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
    try {
      await withTimeout(context?.close(), 30_000)
    } catch {}
    try {
      probe?.closeAllConnections()
      await withTimeout(new Promise<void>((r) => probe?.close(() => r())), 5_000)
    } catch {}
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {}
  })

  const pushOffscreen = (msg: Record<string, unknown>): Promise<unknown> =>
    messenger.evaluate((m) => {
      void chrome.runtime.sendMessage(m).catch(() => {})
    }, msg)

  test.skip('会话状态不进角标（角标只报脚本运行数）；进行中登记随收尾撤下', async () => {
    const c1 = 'e2e-count-1'
    const c2 = 'e2e-count-2'

    const otherUrl = `${probeUrl}other`
    const page = await context!.newPage()
    await page.goto(probeUrl)
    const otherPage = await context!.newPage()
    await otherPage.goto(otherUrl)
    const [probeTabId] = await tabIdsOf(sw, probeUrl)
    const [otherTabId] = await tabIdsOf(sw, otherUrl)
    expect(probeTabId, '探针页的 tabId 应能反查到').toBeGreaterThan(0)
    expect(otherTabId, '另一页的 tabId 应能反查到').toBeGreaterThan(0)

    await expectNoScriptBadge(sw, otherTabId!)
    await expectNoScriptBadge(sw, probeTabId!)

    await pushOffscreen({ kind: 'chat:running', conversationId: c1 })
    await expect.poll(() => runningOf(messenger)).toEqual([c1])
    await expectNoScriptBadge(sw, otherTabId!)

    await pushOffscreen({ kind: 'chat:finished', conversationId: c1 })
    await expect.poll(() => runningOf(messenger), { message: '收尾后不该还挂在进行中' }).toEqual([])
    await expectNoScriptBadge(sw, otherTabId!)

    await pushOffscreen({ kind: 'chat:running', conversationId: c2 })
    await expect.poll(() => runningOf(messenger)).toEqual([c2])
    await expectNoScriptBadge(sw, probeTabId!)
    await pushOffscreen({ kind: 'chat:finished', conversationId: c2 })
    await expect.poll(() => runningOf(messenger)).toEqual([])

    await page.close()
    await otherPage.close()
  })
})

test.describe.serial('对话真链路（popup 对话卡 + 模型 stub）', () => {
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
    probeUrl = `http://127.0.0.1:${addr.port}`

    const setupPage = await context.newPage()
    await setupPage.goto(`chrome-extension://${extensionId}/workbench.html`)
    await saveStubModel(setupPage, { baseUrl: stub.stub.baseUrl })
    await setupPage.close()
  })

  test.afterAll(async () => {
    const withTimeout = (p: Promise<unknown> | undefined, ms: number) =>
      p ? Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve()
    try {
      await withTimeout(context?.close(), 30_000)
    } catch {}
    try {
      stub?.server.closeAllConnections()
      await withTimeout(new Promise<void>((r) => stub?.server.close(() => r())), 5_000)
    } catch {}
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {}
  })

  async function openProbe(): Promise<{ page: Page; tabId: number }> {
    const url = `${probeUrl}/`
    const page = await context!.newPage()
    await page.goto(url)
    let tabId = 0
    await expect
      .poll(async () => {
        const ids = await tabIdsOf(sw, url)
        tabId = ids[0] ?? 0
        return tabId
      })
      .toBeGreaterThan(0)
    return { page, tabId }
  }

  async function openChat(tabId: number): Promise<Page> {
    const page = await context!.newPage()
    await page.goto(chatPageUrl(extensionId, tabId))
    return page
  }

  test('点停止：任务就地中止，半截照样落盘（带「已中断」）', async () => {
    stub.setOptions({ delayMs: 0, holdAfterFirstChunkMs: 20_000 })

    const { page: site, tabId } = await openProbe()
    const chat = await openChat(tabId)
    const box = chat.getByRole('textbox').first()
    await box.fill('停我')
    await box.press('Enter')

    const before = stub.stub.hits.length
    await expect
      .poll(() => stub.stub.hits.length, {
        timeout: 20_000,
        message: '模型没收到这一轮的请求：任务还没跑起来，此时点停止等于没拦',
      })
      .toBeGreaterThan(before)
    const thread = chat.getByRole('log')
    await expect(
      thread.getByText('正在思考…'),
      '流式期间正文由 Shimmer 顶着（会变的正文有意不渲染），见到它才是这一轮在收流',
    ).toBeVisible()

    await chat.getByLabel('Submit').click()
    await expect(
      thread.getByText('正在思考…'),
      '点停止后本地流要断：Shimmer 该撤掉、换成已生成的那半截',
    ).toBeHidden({ timeout: 10_000 })

    const reader = await context!.newPage()
    await reader.goto(`chrome-extension://${extensionId}/workbench.html`)
    const readLatest = async (): Promise<StoredMessage[]> => await readStoredMessages(reader)

    await expect
      .poll(async () => (await readLatest()).some((m) => m.role === 'assistant'), {
        timeout: 10_000,
        message: '点停止后，已生成的那半截也要落盘（等不到说明没拦住，任务还在跑）',
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
    await chat.close()
    await site.close()
  })

  test('关掉标签页：任务就地中止、半截照样落盘（带「已中断」）', async () => {
    stub.setOptions({ delayMs: 0, holdAfterFirstChunkMs: 20_000 })

    const { page: site, tabId } = await openProbe()
    const chat = await openChat(tabId)
    const box = chat.getByRole('textbox').first()
    await box.fill('你好')
    await box.press('Enter')

    const before = stub.stub.hits.length
    await expect
      .poll(() => stub.stub.hits.length, {
        timeout: 20_000,
        message: '模型没收到这一轮的请求：任务还没跑起来，关标签页也就无从中止',
      })
      .toBeGreaterThan(before)
    const thread = chat.getByRole('log')
    await expect(
      thread.getByText('正在思考…'),
      '流式期间正文由 Shimmer 顶着，见到它才是这一轮在收流',
    ).toBeVisible()

    await site.close()

    const reader = await context!.newPage()
    await reader.goto(`chrome-extension://${extensionId}/workbench.html`)
    const readLatest = async (): Promise<StoredMessage[]> => await readStoredMessages(reader)

    await expect
      .poll(async () => (await readLatest()).some((m) => m.role === 'assistant'), {
        timeout: 15_000,
        message: '中止后的半截也该落进会话历史',
      })
      .toBe(true)
    const assistant = (await readLatest()).find((m) => m.role === 'assistant')
    expect(
      assistant?.parts.some((p) => p.type === 'data-interrupted'),
      '半截要带「已中断」标记：没就地中止的话这一轮会跑完，落盘成一条完整回复',
    ).toBe(true)
    await reader.close()

    stub.setOptions({ delayMs: 6_000, holdAfterFirstChunkMs: 0 })
    await chat.close()
  })
})

async function tabIdsOf(sw: Worker, url: string): Promise<number[]> {
  return await sw.evaluate(
    async (u) => (await chrome.tabs.query({})).filter((t) => t.url === u).map((t) => t.id ?? -1),
    url,
  )
}

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

async function runningOf(sender: Page): Promise<string[]> {
  const res = (await sender.evaluate(
    async () => await chrome.runtime.sendMessage({ kind: 'sw:runningChats' }),
  )) as { ok: boolean; data?: string[] } | undefined
  return res?.ok ? (res.data ?? []) : []
}
