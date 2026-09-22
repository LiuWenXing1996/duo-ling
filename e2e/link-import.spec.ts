// 端测：从链接导入 —— 从「抓得下来」一路验到「装上真能跑」。
//
// 这条 spec 的存在理由：单测把 fetch mock 掉了、也不碰真实注入，而这里三件事只有在
// **真浏览器 + 真扩展页 + 真 HTTP 请求 + 真 userScripts 注入**下才作数：
//   ① 扩展页跨域抓取能不能过（本地服务**刻意不带任何 CORS 头**，与真实站点形态一致：
//      扩展页若受 CORS 约束，这一条必红）；
//   ② 302 跳转后还能不能取回（真实分发地址多半有一跳）；
//   ③ 没声明 @grant 的脚本装上后，页面上**拿不到** GM 成员（对齐 TM：不写 @grant = 空清单，
//      不做「无 grant 就全注入」的推断）。
//
// 走法：起本地 http 服务 → 工作台里走完整导入动线 → 启用 → 打开探针页读脚本写下的 DOM 标记。
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import * as http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  enableUserScripts,
  extensionIdFromServiceWorker,
  getServiceWorker,
  launchExtensionContext,
  openMessengerPage,
  sendToSw,
} from './extension'

const SCRIPT_NAME = 'E2E 链接导入样本'
/** 脚本往页面写的标记（**写在崩之前**）：`typeof GM_setValue` 是不是 function，一眼可判权限有没有补上 */
const MARKER_ATTR = 'data-dl-link-imported'

/**
 * 样本脚本：没声明 @grant（对齐 TM 就是空清单，GM 成员一个都没有）；另带
 * `@updateURL` / `@homepageURL`（验油猴的分发来源键真的落进 config）。
 *
 * 标记行排在 `GM_getResourceText` 之前是**有意的**：那一行必然 ReferenceError（本扩展没这个成员），
 * 而标记要先落进 DOM 才断言得到。
 */
function sampleScript(port: number): string {
  return [
    '// ==UserScript==',
    `// @name ${SCRIPT_NAME}`,
    '// @version 9.9.9',
    '// @author e2e',
    '// @match http://127.0.0.1/*',
    `// @updateURL http://127.0.0.1:${port}/x.meta.js`,
    `// @homepageURL http://127.0.0.1:${port}/`,
    '// ==/UserScript==',
    `document.documentElement.setAttribute('${MARKER_ATTR}', typeof GM_setValue)`,
    "const icon = GM_getResourceText('icon')",
    "console.log('link import sample', icon)",
    '',
  ].join('\n')
}

test.describe.serial('从链接导入（真机抓取与注入）', () => {
  let context: BrowserContext
  let extensionId = ''
  let server: http.Server
  let port = 0
  let profileDir = ''
  let page: Page
  let messenger: Page

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-e2e-link-'))

    // —— Phase A：引导 userScripts 开关（无头下走 chrome.developerPrivate），随 profile 持久化 ——
    // 最后一条用例要验真实注入，故这一步不能省（照 smoke.spec 的两阶段姿势）。
    const bootstrapCtx = await launchExtensionContext(profileDir)
    const bootstrapId = extensionIdFromServiceWorker(await getServiceWorker(bootstrapCtx))
    await enableUserScripts(bootstrapCtx, bootstrapId)
    await bootstrapCtx.close()

    // —— Phase B：同一 profile 重新拉起，扩展上下文重启后 chrome.userScripts 才可用 ——
    context = await launchExtensionContext(profileDir)
    extensionId = extensionIdFromServiceWorker(await getServiceWorker(context))
    messenger = await openMessengerPage(context, extensionId)

    // 不带 CORS 头的静态服务：/x.user.js 给脚本、/hop.user.js 302 跳过去、其余给网页
    server = http.createServer((req, res) => {
      const url = req.url ?? '/'
      if (url.startsWith('/x.user.js')) {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        res.end(sampleScript(port))
        return
      }
      if (url.startsWith('/hop.user.js')) {
        res.writeHead(302, { location: '/x.user.js' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><head><title>脚本页</title></head><body><h1>这是个网页</h1></body></html>')
    })
    port = await new Promise((r) => {
      server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port))
    })

    page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/workbench.html`)
    await page.locator('button[aria-label="脚本列表"]').click()
    await expect(page.locator('.workspace-panel')).not.toBeEmpty({ timeout: 15_000 })
  })

  test.afterAll(async () => {
    const withTimeout = (p: Promise<unknown> | undefined, ms: number) =>
      p ? Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve()
    try { await withTimeout(messenger?.close(), 5_000) } catch { /* 忽略 */ }
    try { await withTimeout(page?.close(), 5_000) } catch { /* 忽略 */ }
    try { await withTimeout(context?.close(), 30_000) } catch { /* 忽略 */ }
    try {
      server?.closeAllConnections()
      await withTimeout(new Promise<void>((r) => server?.close(() => r())), 5_000)
    } catch { /* 忽略 */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })

  /** 打开「从链接导入」弹窗（真实浏览器里菜单可以正常点开） */
  async function openLinkDialog(): Promise<void> {
    await page.getByRole('button', { name: '导入' }).first().click()
    await page.getByRole('menuitem', { name: '从链接导入' }).click()
    await expect(page.getByLabel('脚本地址')).toBeVisible()
  }

  /**
   * 把弹窗拨回输入态。**每条用例开头都要调**：用例间共享同一个弹窗，上一轮成功取回会停在
   * 确认态（地址框锁住），上一轮失败则已经是输入态 —— 靠「有没有『重新填写』按钮」分辨，
   * 别假定上一条留下了什么（第一版就是这么白等了一次 120s 超时）。
   */
  async function ensureInputState(): Promise<void> {
    const refill = page.getByTestId('link-import-refill')
    if (await refill.isVisible().catch(() => false)) await refill.click()
    await expect(page.getByLabel('脚本地址')).toBeVisible()
    await expect(page.getByTestId('link-import-fetch')).toBeVisible()
  }

  /** 填地址 → 点「获取」→ 等取回落定（成功后地址框锁上、主按钮变「安装」，用它当信号） */
  async function fetchLink(url: string): Promise<void> {
    await page.getByLabel('脚本地址').fill(url)
    await page.getByTestId('link-import-fetch').click()
    await expect(page.getByTestId('link-import-install')).toBeVisible({ timeout: 15_000 })
  }

  test('跨域抓取（无 CORS 头的站点）→ 确认区展示摘要', async () => {
    await openLinkDialog()
    await fetchLink(`http://127.0.0.1:${port}/x.user.js`)

    // ① 跨域抓取过了：确认区由抓回的源码渲染出来
    await expect(page.getByText(SCRIPT_NAME)).toBeVisible()
    await expect(page.getByText('9.9.9')).toBeVisible()
    await expect(page.getByText('匹配 1 条规则')).toBeVisible()

    // ② 此刻**还没落盘**：列表里不该有这个名字
    await expect(page.locator('.workspace-panel')).not.toContainText(SCRIPT_NAME)
  })

  test('302 跳转后仍能取回（真实分发地址多半有一跳）', async () => {
    await ensureInputState()
    await fetchLink(`http://127.0.0.1:${port}/hop.user.js`)
    await expect(page.getByText(SCRIPT_NAME)).toBeVisible()
  })

  test('网页地址：给人话，不落盘', async () => {
    await ensureInputState()
    await page.getByLabel('脚本地址').fill(`http://127.0.0.1:${port}/page.html`)
    await page.getByTestId('link-import-fetch').click()
    await expect(page.getByText('不是脚本源码')).toBeVisible()
    // 没进确认态：主按钮仍是「获取」
    await expect(page.getByTestId('link-import-fetch')).toBeVisible()
  })

  test('安装：落进脚本列表，自声明的来源与「空 grant」都落库', async () => {
    await ensureInputState()
    await fetchLink(`http://127.0.0.1:${port}/x.user.js`)
    await page.getByTestId('link-import-install').click()

    // 导入报告（与其它三条导入入口同一份）弹出来，且复述来源
    await expect(page.getByText(/导入完成：成功 1 个/)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(`来源：http://127.0.0.1:${port}/x.user.js`)).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.locator('.workspace-panel')).toContainText(SCRIPT_NAME)
    await expect(page.locator('.workspace-panel')).toContainText('刚导入')

    // —— 落库记录：这一层单测看不到（单测只验到「传给落盘通道的源码里有什么」）——
    const listRes = await sendToSw<Array<{ uuid: string; name: string }>>(messenger, {
      kind: 'userscript:list',
    })
    expect(listRes.ok).toBe(true)
    if (!listRes.ok) return
    const script = listRes.data.find((s) => s.name === SCRIPT_NAME)
    expect(script, '导入的脚本应出现在状态库里').toBeTruthy()

    const projRes = await sendToSw<{
      config: { grant?: string[]; updateUrl?: string; homepageUrl?: string; matches: string[] }
    }>(messenger, { kind: 'userscript:getProject', uuid: script!.uuid })
    expect(projRes.ok).toBe(true)
    if (!projRes.ok) return
    const cfg = projRes.data.config
    // 脚本没写 @grant → config 里不该凭空长出 grant（对齐 TM：不写 = 空清单，不做「必填推断」）
    expect(cfg.grant).toBeUndefined()
    // 油猴的分发来源键照原样落库
    expect(cfg.updateUrl).toBe(`http://127.0.0.1:${port}/x.meta.js`)
    expect(cfg.homepageUrl).toBe(`http://127.0.0.1:${port}/`)
    expect(cfg.matches).toEqual(['http://127.0.0.1/*'])
  })

  test('启用后注入探针页：没写 @grant 的脚本在页面上拿不到 GM 成员（对齐 TM）', async () => {
    const listRes = await sendToSw<Array<{ uuid: string; name: string }>>(messenger, {
      kind: 'userscript:list',
    })
    expect(listRes.ok).toBe(true)
    if (!listRes.ok) return
    const script = listRes.data.find((s) => s.name === SCRIPT_NAME)
    expect(script).toBeTruthy()

    // 启用 = 真的注册进 chrome.userScripts（这一步没走 UI 的开关，只是为了不让本用例依赖列表 DOM）
    const toggled = await sendToSw(messenger, { kind: 'userscript:toggle', uuid: script!.uuid, enabled: true })
    expect(toggled.ok).toBe(true)

    // 新开探针页（matches 是 http://127.0.0.1/*），读脚本写下的标记
    const probe = await context.newPage()
    try {
      await probe.goto(`http://127.0.0.1:${port}/probe.html`)
      await probe.waitForFunction(
        (attr: string) => document.documentElement.getAttribute(attr) !== null,
        MARKER_ATTR,
        { timeout: 15_000 },
      )
      // 'undefined' = GM_setValue 不在脚本作用域里 —— 与 TM 一致：不写 @grant 就等于空清单，
      // 不替脚本推断权限（该 ReferenceError 就 ReferenceError，脚本的行为与自己的 @grant 一致）
      expect(await probe.locator('html').getAttribute(MARKER_ATTR)).toBe('undefined')
    } finally {
      await probe.close()
    }
  })
})
