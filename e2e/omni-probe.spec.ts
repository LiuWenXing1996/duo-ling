// GM 全能探针的端测（L3 · 真机自动化）。
//
// 把手测探针搬进无头 CI：源码从 `uscript-samples/omni-probe/omni-probe.user.js` **读盘**（真身与手测同一份，
// 不另写一套），经命令面存成脚本注入，打开本机靶站的探针页跑一遍，断言行里没有 ✗。
//
// 探针**载入不自动跑**（`@match` 是 `*://*/*`，逢页跑会到处落文件 / 弹通知 / 覆盖剪贴板），
// 只有 URL hash 带 `omni-probe-auto` 的端测模式才载入即跑 —— 本 spec 正是用 `PAGE_HASH` 走这条，
// 故不用点「跑全部」；万一没起来（AUTO 没生效），兜底点一次。出网目标也是本机的：`scripts/probe-target.mjs` 起的靶站。
//
// 人工档 4 项（剪贴板读回 / 浏览器原生右键菜单点击 / `saveAs` 的另存为框 / 系统通知点击）在无头下
// 做不了，探针在 `#omni-probe-auto`（AUTO）下直接记 `?`；另有 3 项会因环境记 `?`：
//   · `@resource` —— 地址写在元数据里（只能是固定值、指向靶站默认端口），故这里优先占默认端口起靶站；
//   · 剪贴板富文本 —— 读回被拒（未授权 / 页面未聚焦）；
//   · `@require` 的 CDN 依赖 —— 离线时抓不到（抓取失败不阻断注册，见 require-cache 的约定）。
// 故预期：✗ = 0、⋯ = 0、`?` ≤ 7、其余 ✓。总数写死 —— 用例被增删时这条断言负责红。
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORT, startProbeTarget, type ProbeTarget } from '../scripts/probe-target.mjs'
import {
  enableUserScripts,
  extensionIdFromServiceWorker,
  getServiceWorker,
  launchExtensionContext,
  openMessengerPage,
  sendToSw,
} from './extension'

/** 探针源码（与手测同一份） */
const PROBE_SRC = readFileSync(fileURLToPath(new URL('../uscript-samples/omni-probe/omni-probe.user.js', import.meta.url)), 'utf8')
/** 探针面板根节点 id */
const PANEL = '#omni-probe'
/** 自动化开关：人工档直接记「?」，不干等（见探针里的 AUTO 注释） */
const PAGE_HASH = '#omni-probe-auto'
/** 面板底部汇总行：`—— ✓63 ✗0 ?5 / 共 68` */
const SUMMARY_RE = /—— ✓(\d+) ✗(\d+) \?(\d+)(?: ⋯(\d+))? \/ 共 (\d+)/
/** 用例总数（探针里 add(...) 的条数） */
const TOTAL = 68
/** 无人动手时能接受的未判定数：人工档 4 项 + 3 项环境性（@resource / 剪贴板富文本 / @require 的 CDN） */
const MAX_UNKNOWN = 7

test.describe.serial('GM 全能探针（真机自动化）', () => {
  let context: BrowserContext | undefined
  let messenger: Page | undefined
  let profileDir = ''
  let available = false
  let scriptUuid = ''
  let target: ProbeTarget | undefined

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-omni-probe-e2e-'))

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
      code: PROBE_SRC,
    })
    expect(saved.ok, 'userscript:save 应成功').toBe(true)
    // @require 抓不到不阻断注册（require-cache 的约定），故这里只要求没报注册错误
    if (saved.ok) expect(saved.data.registerError, '注册不应报错').toBeUndefined()

    // 本地靶站：既是探针页宿主，也是探针的出网目标。优先占默认端口 —— 探针的 @resource 地址写在
    // 元数据里、只能是固定值（默认端口），占到了那条用例才验得了；占用失败退回随机端口。
    target = await startProbeTarget({ port: DEFAULT_PORT }).catch(() => undefined)
    if (!target) target = await startProbeTarget({ port: 0 })

    // 剪贴板用例在 AUTO 下走 navigator.clipboard.read() / readText()：授了权限才能自动验
    // 「写进去的到底是什么」，不必等人按 Cmd+V
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: target.base })
  })

  test.afterAll(async () => {
    const withTimeout = (p: Promise<unknown> | undefined, ms: number) =>
      p ? Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve()
    try { await withTimeout(context?.close(), 30_000) } catch { /* 忽略 */ }
    try { await withTimeout(target?.close(), 5_000) } catch { /* 忽略 */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })

  test('全量 GM API 在真机上没有一条 ✗', async () => {
    test.skip(!available, 'chrome.userScripts 引导失败，注入面转手测')
    const page = await context!.newPage()
    await page.goto(`${target!.base}/probe.html${PAGE_HASH}`)

    // 1. 脚本已注入并执行：面板出现
    await expect(page.locator(PANEL), '面板应出现（脚本未注入？）').toBeVisible({ timeout: 20_000 })
    await expect(page.locator(PANEL)).toContainText('跑全部')

    // 2. 等跑批走完：`PAGE_HASH` 让探针处于端测模式，载入即自动开跑。40s 还没见汇总行
    //    （自动跑没起来）就兜底点一次 —— 按钮在 running 时会忽略点击，故重复点击无害。
    const deadline = Date.now() + 180_000
    let panelText = ''
    let clicked = false
    while (Date.now() < deadline) {
      panelText = (await page.locator(PANEL).textContent()) ?? ''
      if (/—— ✓/.test(panelText)) break
      if (!clicked && Date.now() > deadline - 140_000) {
        clicked = true
        await page.getByRole('button', { name: '跑全部' }).click().catch(() => undefined)
      }
      await page.waitForTimeout(1000)
    }

    // 3. 断言：汇总行在场、✗ = 0、无 ⋯、用例数与未判定数在预期内
    panelText = (await page.locator(PANEL).textContent()) ?? panelText
    const m = panelText.match(SUMMARY_RE)
    expect(m, `没等到汇总行，面板文本：\n${panelText}`).not.toBeNull()
    if (!m) return
    const ok = Number(m[1])
    const bad = Number(m[2])
    const unknownCount = Number(m[3])
    const pending = Number(m[4] ?? 0)
    const total = Number(m[5])
    console.log(`[E2E] 探针汇总：✓${ok} ✗${bad} ?${unknownCount} ⋯${pending} / 共 ${total}`)
    console.log(panelText)

    expect(bad, `有 API 在真机上是 ✗：\n${panelText}`).toBe(0)
    expect(pending, `还有人工项没收尾（AUTO 下应直接记 ?）：\n${panelText}`).toBe(0)
    expect(total, '探针用例数变了（新增 / 删除了用例？）').toBe(TOTAL)
    expect(unknownCount, `未判定的行多于预期（人工 4 项 + 环境性 3 项）：\n${panelText}`).toBeLessThanOrEqual(MAX_UNKNOWN)
    // 剪贴板那条在 AUTO 下走 clipboard.readText() 自动回读，不该落到「端测读不到剪贴板」
    expect(panelText, '剪贴板回读没成（应走 clipboard.readText()）').not.toContain('端测读不到剪贴板')
    expect(ok, `通过数偏少（总数 ${TOTAL} 减掉允许未判定的 ${MAX_UNKNOWN} 项）：\n${panelText}`).toBeGreaterThanOrEqual(TOTAL - MAX_UNKNOWN)
    await page.close()
  })
})
