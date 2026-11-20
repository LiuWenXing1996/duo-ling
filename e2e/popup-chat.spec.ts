import { test, expect, type BrowserContext, type Page, type Worker } from '@playwright/test'
import * as http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chatPageUrl,
  checkUserScriptsAvailable,
  enableUserScripts,
  extensionIdFromServiceWorker,
  getServiceWorker,
  launchExtensionContext,
  openMessengerPage,
  sendToSw,
} from './extension'

const HIT_MARK = 'data-e2e-hit'
const INSPECTOR_ID = 'dl-page-inspector'
const HIT_MATCH = 'http://127.0.0.1/hit*'

test.describe.serial('popup 对话载体', () => {
  let context: BrowserContext | undefined
  let sw: Worker
  let messenger: Page
  let extensionId = ''
  let profileDir = ''
  let server: http.Server | undefined
  let baseUrl = ''
  let engine = false
  let hitScriptUuid = ''

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-popup-e2e-'))

    const boot = await launchExtensionContext(profileDir)
    const bootSw = await getServiceWorker(boot)
    await enableUserScripts(boot, extensionIdFromServiceWorker(bootSw))
    await boot.close()

    context = await launchExtensionContext(profileDir)
    sw = await getServiceWorker(context)
    extensionId = extensionIdFromServiceWorker(sw)
    messenger = await openMessengerPage(context, extensionId)
    engine = await checkUserScriptsAvailable(sw)

    const probe = http.createServer((req, res) => {
      const hit = (req.url ?? '').startsWith('/hit')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>probe</title></head>' +
          `<body>${hit ? '<h1 id="target">probe 目标</h1>' : '<p>no target</p>'}</body></html>`,
      )
    })
    server = probe
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
    const addr = probe.address()
    if (!addr || typeof addr === 'string') throw new Error('探针页地址取不到')
    baseUrl = `http://127.0.0.1:${addr.port}`

    if (!engine) return

    const created = await sendToSw<{ uuid: string }>(messenger, { kind: 'userscript:create' })
    if (!created.ok) throw new Error(`建探针脚本失败：${created.error}`)
    hitScriptUuid = created.data.uuid
    const saved = await sendToSw<{ registerError?: string }>(messenger, {
      kind: 'userscript:save',
      uuid: hitScriptUuid,
      code: [
        '// ==UserScript==',
        '// @name e2e 命中页脚本',
        '// @namespace duoling.e2e',
        '// @grant none',
        `// @match ${HIT_MATCH}`,
        '// ==/UserScript==',
        `document.documentElement.setAttribute('${HIT_MARK}', '1')`,
        '',
      ].join('\n'),
    })
    if (!saved.ok) throw new Error(`存探针脚本失败：${saved.error}`)
    if (saved.data.registerError) throw new Error(`注册探针脚本失败：${saved.data.registerError}`)

    await expect
      .poll(
        () =>
          sw.evaluate(async (id) => {
            try {
              return (await chrome.userScripts.getScripts()).some((s) => s.id === id)
            } catch {
              return false
            }
          }, INSPECTOR_ID),
        { timeout: 15_000, message: '页面检查器没进注册表：SW 启动链没走完' },
      )
      .toBe(true)
  })

  test.afterAll(async () => {
    const withTimeout = (p: Promise<unknown> | undefined, ms: number) =>
      p ? Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve()
    try {
      if (hitScriptUuid)
        await sendToSw(messenger, { kind: 'userscript:remove', uuid: hitScriptUuid })
    } catch {}
    try {
      await withTimeout(messenger?.close(), 5_000)
    } catch {}
    try {
      await withTimeout(context?.close(), 30_000)
    } catch {}
    try {
      if (server) {
        server.closeAllConnections()
        await withTimeout(new Promise<void>((r) => server!.close(() => r())), 5_000)
      }
    } catch {}
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {}
  })

  async function tabIdOf(url: string): Promise<number> {
    let id = 0
    await expect
      .poll(async () => {
        const ids = await sw.evaluate(
          async (u) =>
            (await chrome.tabs.query({})).filter((t) => t.url === u).map((t) => t.id ?? -1),
          url,
        )
        id = ids[0] ?? 0
        return id
      })
      .toBeGreaterThan(0)
    return id
  }

  async function openSite(path: string): Promise<{ page: Page; tabId: number }> {
    const url = baseUrl + path
    const page = await context!.newPage()
    await page.goto(url)
    return { page, tabId: await tabIdOf(url) }
  }

  async function openPopup(tabId: number): Promise<Page> {
    const page = await context!.newPage()
    await page.goto(chatPageUrl(extensionId, tabId))
    return page
  }

  test('草稿：敲完就关窗，重开同一标签页还在；清空后重开是空的', async () => {
    const { page: site, tabId } = await openSite('/miss')

    const first = await openPopup(tabId)
    await first.getByRole('textbox').first().fill('草稿不该随窗口消失')
    await first.close()

    const second = await openPopup(tabId)
    await expect(second.getByRole('textbox').first()).toHaveValue('草稿不该随窗口消失')

    await second.getByRole('textbox').first().fill('')
    const draftKey = `dl-chat-draft:${tabId}`
    await expect
      .poll(
        async () =>
          await second.evaluate(
            async (k) => (await chrome.storage.session.get(k))[k] ?? null,
            draftKey,
          ),
      )
      .toBe(null)
    await second.close()

    const third = await openPopup(tabId)
    await expect(third.getByRole('textbox').first()).toHaveValue('')
    await third.close()
    await site.close()
  })

  test('灵动岛：只报 ?tab= 那一页的脚本数，没命中的页上不出现', async () => {
    test.skip(!engine, 'chrome.userScripts 引导失败：脚本注入面转手测')

    const { page: hit, tabId: hitTab } = await openSite('/hit')
    await expect
      .poll(() => hit.evaluate((m) => document.documentElement.hasAttribute(m), HIT_MARK), {
        timeout: 20_000,
        message: '探针脚本没注入到这一页',
      })
      .toBe(true)

    const popup = await openPopup(hitTab)
    const island = popup.locator('[data-testid="page-monitor"]')
    await expect(island).toBeVisible()
    await expect(island).toContainText(/1\s*个脚本在运行/)
    await popup.close()
    await hit.close()

    const { page: miss, tabId: missTab } = await openSite('/miss')
    const other = await openPopup(missTab)
    await expect(other.locator('[data-testid="page-monitor"]')).toHaveCount(0)
    expect(
      await miss.evaluate((m) => document.documentElement.hasAttribute(m), HIT_MARK),
      '@match 被丢成全域时先在这里暴露，别误判成归属串页',
    ).toBe(false)
    await other.close()
    await miss.close()
  })

  test('拾取：popup 关掉也不丢结果；重开即见 chip，读过不删，× 后彻底消失', async () => {
    test.skip(!engine, 'chrome.userScripts 引导失败：点选转手测')

    const { page: site, tabId } = await openSite('/hit')
    await expect
      .poll(() => site.evaluate((m) => document.documentElement.hasAttribute(m), HIT_MARK), {
        timeout: 20_000,
        message: '探针页没就绪，点选链路无从验起',
      })
      .toBe(true)

    const popup = await openPopup(tabId)
    const button = popup.locator('[data-testid="pick-element-button"]')
    const error = popup.locator('[data-testid="context-error"]')
    let closedByItself = false
    for (let attempt = 0; attempt < 3 && !closedByItself; attempt++) {
      const closed = popup
        .waitForEvent('close', { timeout: 3_000 })
        .then(() => true)
        .catch(() => false)
      await button.click().catch(() => {})
      closedByItself = await closed
      if (closedByItself) break
      await popup.waitForTimeout(600)
      if ((await error.count()) === 0) break
      await site.reload()
      await site.waitForTimeout(1_000)
    }
    if (!closedByItself) await popup.close()

    await expect(site.locator('.duoling-picker-box')).toHaveCount(1)
    await site.locator('#target').click()

    const reopened = await openPopup(tabId)
    await expect(reopened.locator('[data-testid="page-context-chips"]')).toContainText(
      '已点选：<h1#target>',
    )
    await reopened.close()

    const again = await openPopup(tabId)
    await expect(again.locator('[data-testid="page-context-chips"]')).toContainText(
      '已点选：<h1#target>',
    )

    await again.locator('[data-testid="clear-picked-element"]').click()
    const resultKey = `dl-pick-result:${tabId}`
    await expect
      .poll(
        async () =>
          await again.evaluate(
            async (k) => (await chrome.storage.session.get(k))[k] ?? null,
            resultKey,
          ),
      )
      .toBe(null)
    await again.close()

    const afterClear = await openPopup(tabId)
    await expect(afterClear.locator('[data-testid="page-context-chips"]')).toHaveCount(0)
    await afterClear.close()
    await site.close()
  })
})
