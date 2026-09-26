// GM 可用性矩阵的端测（L3 · 真机自动化）。
//
// 把手测探针搬进无头 CI：源码从 `uscript-samples/gm-matrix/script.js` **读盘**（真身与手测同一份，
// 不另写一套），经命令面存成脚本注入，打开本地探针页跑一遍，断言行里没有 ✗。
//
// 引导姿势与 smoke.spec.ts 共用 `e2e/extension.ts`：Phase A 程序化开 userScripts 开关（chrome
// 无 UI 走 chrome.developerPrivate）→ 同 profile 重启 → `chrome.userScripts` 由 undefined 变可用。
// 这条路在 CI 上已被 smoke 证明可行（其中一条断言 available === true）。
//
// 矩阵里两项要人动手的，端测的处理：
//   · GM_setClipboard     —— 给该 origin 授 clipboard-read 权限后走 navigator.clipboard.readText()
//     自动验「写进去的到底是什么」（**自动**）
//   · GM_registerMenuCommand —— 点的是浏览器**原生右键菜单**，Playwright 碰不到 → 只验「四种调用」，记「?」
// 故这里的预期是：✗ = 0（无伪失败，契约误判已重校）、? ≈ 5（VM 未实现的标准 API
// [GM_audio ×2 / GM_getTab·saveTab·getTabs ×2 / window.onurlchange ×1，均非 duo-ling 独有]；
// cookie 两形态 GM.cookie.*（Promise）与 GM_cookie.*（全局回调）均已接通、clipboard 经授权自动验，均已不归 ?）、
// ✓ ≈ 28（XHR/download 经 VM requests.js + offscreen 已接通；cookie 4 用例全 ✓）、无 ⋯。
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import * as http from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  enableUserScripts,
  extensionIdFromServiceWorker,
  getServiceWorker,
  launchExtensionContext,
  openMessengerPage,
  sendToSw,
} from './extension'

/** 探针源码（与手测同一份） */
const MATRIX_SRC = readFileSync(fileURLToPath(new URL('../uscript-samples/gm-matrix/script.js', import.meta.url)), 'utf8')
/** 探针面板根节点 id */
const PANEL = '#gm-matrix-probe'
/** 自动化开关：跳过两处 confirm + 跳过两项端测做不了的人工项（见探针里的 AUTO 注释） */
const PAGE_HASH = '#gm-matrix-auto'
/** 面板底部汇总行：`—— ✓26 ✗0 ?2 / 共 28` */
const SUMMARY_RE = /—— ✓(\d+) ✗(\d+) \?(\d+)(?: ⋯(\d+))? \/ 共 (\d+)/

test.describe.serial('GM 可用性矩阵（真机自动化）', () => {
  let context: BrowserContext | undefined
  let messenger: Page | undefined
  let profileDir = ''
  let available = false
  let scriptUuid = ''
  let server: http.Server | undefined
  let port = 0

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-matrix-e2e-'))

    // Phase A：程序化打开 userScripts 开关（随 profile 持久化）
    const bootstrapCtx = await launchExtensionContext(profileDir)
    const bootstrapSw = await getServiceWorker(bootstrapCtx)
    await enableUserScripts(bootstrapCtx, extensionIdFromServiceWorker(bootstrapSw))
    await bootstrapCtx.close()

    // Phase B：同 profile 重启，开关生效
    context = await launchExtensionContext(profileDir)
    const sw = await getServiceWorker(context)
    messenger = await openMessengerPage(context, extensionIdFromServiceWorker(sw))
    const availability = await sendToSw<{ available: boolean }>(messenger, { kind: 'userscript:availability' })
    available = availability.ok === true && availability.data.available === true
    if (!available) return // 后面的 test.skip 兜住

    // 存成脚本：单文件源码（探针的 @grant 清单写全，覆盖全部 API）
    const created = await sendToSw<{ uuid: string }>(messenger, { kind: 'userscript:create' })
    expect(created.ok, 'userscript:create 应成功').toBe(true)
    if (!created.ok) return
    scriptUuid = created.data.uuid
    const saved = await sendToSw<{ registerError?: string }>(messenger, {
      kind: 'userscript:save',
      uuid: scriptUuid,
      code: MATRIX_SRC,
    })
    expect(saved.ok, 'userscript:save 应成功').toBe(true)
    if (saved.ok) expect(saved.data.registerError, '注册不应报错').toBeUndefined()

    // 本地探针页：脚本 matches 是 '*://*/*'，http://127.0.0.1 落在默认匹配里
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>矩阵探针页</title></head>' +
          '<body><h1>probe</h1></body></html>',
      )
    })
    port = await new Promise<number>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port))
    })
    // 探针的剪贴板用例在 AUTO 下改走 navigator.clipboard.readText()：授了这道权限它就能自动验
    // 「写进去的到底是什么」，不必等人按 Cmd+V（省掉矩阵里一个固定「?」）
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: `http://127.0.0.1:${port}`,
    })
  })

  test.afterAll(async () => {
    const withTimeout = (p: Promise<unknown> | undefined, ms: number) =>
      p ? Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve()
    try { await withTimeout(context?.close(), 30_000) } catch { /* 忽略 */ }
    try {
      server?.closeAllConnections()
      await withTimeout(new Promise<void>((r) => server?.close(() => r())), 5_000)
    } catch { /* 忽略 */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })

  test('全量 GM API 在真机上没有一条 ✗（两项人工项由 Playwright 代做）', async () => {
    test.skip(!available, 'chrome.userScripts 引导失败，注入面转手测')
    const page = await context!.newPage()
    page.on('console', (m) => {
      const t = m.text()
      if (t.includes('[GMDBG]')) console.log(t)
    })
    await page.goto(`http://127.0.0.1:${port}/probe.html${PAGE_HASH}`)

    // 1. 脚本已注入并执行：面板出现
    await expect(page.locator(PANEL), '面板应出现（脚本未注入？）').toBeVisible({ timeout: 20_000 })
    await expect(page.locator(PANEL)).toContainText('跑全部')

    await page.getByRole('button', { name: '跑全部' }).click()

    // 2. 等跑批结束。余下的「要你动手」项（剪贴板 / 菜单）在 AUTO 下由扩展自动验，不会挂起人工项；
    //    汇总行出现且无 ⋯ 即说明全部判定完成。
    const deadline = Date.now() + 90_000
    let panelText = ''
    while (Date.now() < deadline) {
      panelText = (await page.locator(PANEL).textContent()) ?? ''
      if (/—— ✓/.test(panelText) && !panelText.includes('⋯')) break
      await page.waitForTimeout(1000)
    }

    // 3. 断言：汇总行在场、✗ = 0、无 ⋯、通过数达标
    panelText = (await page.locator(PANEL).textContent()) ?? panelText
    // DIAG：从扩展页（popup）读 SW 落的诊断键，定位「GM API 注入缺失」根因。
    // __vmCmdLog 里 rt: 前缀=runtime.onMessage 命中；无前缀=onUserScriptMessage 命中；
    // __diagGrant 有值=GetInjected 走 onUserScriptMessage；__vmHostErr 有值=装配报错。
    try {
      const diag = await messenger!.evaluate(async () => {
        const keys = ['__diagGrant', '__diagMetaKeys', '__diagScriptCount', '__vmCmdLog', '__vmCmdErr', '__vmHostErr']
        const got = await chrome.storage.session.get(keys)
        const out: Record<string, unknown> = {}
        for (const k of keys) out[k] = got[k]
        return out
      })
      console.log('[E2E-DIAG]', JSON.stringify(diag))
    } catch (e) {
      console.log('[E2E-DIAG] 读取失败', String((e as Error)?.message || e))
    }
    const m = panelText.match(SUMMARY_RE)
    expect(m, `没等到汇总行，面板文本：\n${panelText}`).not.toBeNull()
    if (!m) return
    const ok = Number(m[1])
    const bad = Number(m[2])
    const unknownCount = Number(m[3])
    const pending = Number(m[4] ?? 0)
    const total = Number(m[5])
    console.log(`[E2E] 矩阵汇总：✓${ok} ✗${bad} ?${unknownCount} ⋯${pending} / 共 ${total}`)
    console.log(panelText)

    expect(bad, `有 API 在真机上是 ✗（契约误判已重校，这里只该是 VM 真缺口）：\n${panelText}`).toBe(0)
    expect(pending, `还有人工项没收尾：\n${panelText}`).toBe(0)
    expect(total, '矩阵条目数变了（新增 / 删除了用例？）').toBe(35)
    // VM 下 ? 是真实状态：3 条 cookie/clipboard 后端缺口（cookie 是 MV3 同步桥独立 follow-up、
    // clipboard 无头隔离）+ 6 条 VM 未实现的标准 API（GM_audio / GM_getTab·saveTab·getTabs /
    // window.onurlchange，均非 duo-ling 独有）。这里只兜底上限，避免矩阵悄悄缩水。
    expect(unknownCount, `未判定行数异常（预期 ≤18）：\n${panelText}`).toBeLessThanOrEqual(18)
    expect(ok, `通过数偏少（VM 真实支持约 24 条，XHR/download 已接通）：\n${panelText}`).toBeGreaterThanOrEqual(19)
    await page.close()
  })
})
