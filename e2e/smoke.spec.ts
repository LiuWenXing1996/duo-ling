// 层5 E2E 冒烟（docs/testing-plan.md「E2E 测试面映射」）。
// 覆盖四条面：workbench 页 / SW 命令面 + offscreen 就绪 / 用户脚本注入（window.DL 桥）/ sidepanel 页。
// sidePanel.open() 需 user gesture 且无头无浏览器 UI，不进无头断言（手测覆盖）。
import { test, expect, type BrowserContext, type Page, type Worker } from '@playwright/test'
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
  type UserScriptsBootstrap,
} from './extension'

test.describe.serial('哆灵扩展 E2E 冒烟（层5）', () => {
  let context: BrowserContext | undefined
  let sw: Worker
  let extensionId = ''
  /** 命令面发送端：扩展页（SW 自发 runtime 消息不回环，必须经另一上下文） */
  let messenger: Page | undefined
  let profileDir = ''
  let bootstrap: UserScriptsBootstrap | undefined
  /** 重启扩展上下文后 chrome.userScripts 是否真的可用（引导是否生效的最终判据） */
  let userScriptsAvailable = false

  // —— 本地静态探针页（脚本 matches '*://*/*' 匹配 http(s)，file:// 不行）——
  let probeServer: http.Server | undefined
  let probePort = 0
  const PROBE_MARKER_ID = 'dl-e2e-result'

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-e2e-'))

    // —— Phase A：引导 userScripts 开关（无 UI，走 chrome.developerPrivate），随 profile 持久化 ——
    const bootstrapCtx = await launchExtensionContext(profileDir)
    const bootstrapSw = await getServiceWorker(bootstrapCtx)
    const bootstrapId = extensionIdFromServiceWorker(bootstrapSw)
    bootstrap = await enableUserScripts(bootstrapCtx, bootstrapId)
    await bootstrapCtx.close()

    // —— Phase B：同一 profile重新拉起，开关从持久化 prefs 恢复，扩展上下文重启后
    // chrome.userScripts 从 undefined 变为可用（官方语义：undefined 态只在上下文重载时重置）——
    context = await launchExtensionContext(profileDir)
    sw = await getServiceWorker(context)
    extensionId = extensionIdFromServiceWorker(sw)
    messenger = await openMessengerPage(context, extensionId)
    const availability = await sendToSw<{ available: boolean }>(messenger, { kind: 'userscript:availability' })
    userScriptsAvailable = availability.ok === true && availability.data.available === true

    // 探针页服务：127.0.0.1 随机端口，'*://*/*' 默认匹配规则覆盖 http://127.0.0.1
    probeServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DL 探针页</title></head><body><h1>probe</h1></body></html>')
    })
    probePort = await new Promise((resolvePort) => {
      probeServer!.listen(0, '127.0.0.1', () => resolvePort((probeServer!.address() as { port: number }).port))
    })
  })

  test.afterAll(async () => {
    // 各步独立兜底：任何一步挂住都不能拖垮整个收尾（close 在个别场景会卡住）
    const withTimeout = (p: Promise<unknown> | undefined, ms: number) =>
      p ? Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve()
    try { await withTimeout(messenger?.close(), 5_000) } catch { /* 忽略 */ }
    try { await withTimeout(context?.close(), 30_000) } catch { /* 忽略 */ }
    try {
      probeServer?.closeAllConnections()
      await withTimeout(new Promise<void>((r) => probeServer?.close(() => r())), 5_000)
    } catch { /* 忽略 */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })

  // ———————————————————————————— SW 命令面 ————————————————————————————

  test('SW 自证构建信息 + userscript 命令面应答', async () => {
    const buildInfo = await sendToSw<{ time: string; branch: string }>(messenger!, { kind: 'sw:buildInfo' })
    expect(buildInfo, 'sw:buildInfo 应答信封').toEqual({ ok: true, data: expect.objectContaining({ time: expect.any(String), branch: expect.any(String) }) })

    const list = await sendToSw<unknown[]>(messenger!, { kind: 'userscript:list' })
    expect(list.ok, 'userscript:list 应成功（新 profile 状态库为空）').toBe(true)
    if (list.ok) expect(Array.isArray(list.data), '列表应为数组').toBe(true)
  })

  test('offscreen:ensure 容器就绪（SW 侧轮询 ai:ping 到能应答）', async () => {
    const res = await sendToSw<{ ready: boolean }>(messenger!, { kind: 'offscreen:ensure' })
    expect(res).toEqual({ ok: true, data: { ready: true } })
  })

  test('userScripts 可用性结论（无头 Chromium 引导结果）', async () => {
    const res = await sendToSw<{ available: boolean; chromeMajor: number; guideText: string }>(messenger!, {
      kind: 'userscript:availability',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    console.log('[E2E 结论] userScripts 引导:', JSON.stringify(bootstrap), '→ available =', res.data.available)
    // 引导已按官方语义打开两道开关并重启了扩展上下文；引导路径生效则这里必须可用
    expect(res.data.available, `userScripts 引导失败：${JSON.stringify(bootstrap)}`).toBe(true)
  })

  // ———————————————————————————— workbench 标签页 ————————————————————————————

  test('workbench.html 加载并渲染脚本列表 / 设置导航', async () => {
    const page = await context!.newPage()
    await page.goto(`chrome-extension://${extensionId}/workbench.html`)
    await expect(page).toHaveTitle('哆灵工作台')
    // 左侧导航（脚本列表 / 设置）渲染，工作区容器挂载
    await expect(page.locator('button[aria-label="脚本列表"]')).toBeVisible()
    await expect(page.locator('button[aria-label="设置"]')).toBeVisible()
    await expect(page.locator('.workspace-panel')).toBeVisible()
    // 打开脚本列表标签页，列表区域应出现内容（空列表也有容器）
    await page.locator('button[aria-label="脚本列表"]').click()
    await expect(page.locator('.workspace-panel')).not.toBeEmpty({ timeout: 15_000 })
    await page.close()
  })

  // ———————————————————————————— side panel ————————————————————————————

  test('sidepanel.html 页面可加载（sidePanel.open() 需 user gesture，不进无头断言）', async () => {
    const page = await context!.newPage()
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`)
    await expect(page).toHaveTitle('哆灵')
    await expect(page.locator('#app')).toBeVisible()
    await page.close()
  })

  // ———————————————————————————— 用户脚本注入 ————————————————————————————

  test('用户脚本注入探针页：脚本执行 + window.DL 桥往返', async () => {
    test.skip(!userScriptsAvailable, 'chrome.userScripts 在无头 Chromium 下不可用（引导失败），注入面转手测')

    // 1. 创建脚本：offscreen 侧自动命名 + 初始模板 + esbuild-wasm 构建 + 状态库落盘 + git 快照，SW 注册
    const created = await sendToSw<{ uuid: string; name: string; registerError?: string }>(messenger!, {
      kind: 'userscript:create',
    })
    expect(created.ok, `userscript:create 失败：${created.ok ? '' : created.error}`).toBe(true)
    if (!created.ok) return
    expect(created.data.registerError, '注册不应报错').toBeUndefined()
    const { uuid } = created.data

    // 2. 探针脚本：验证 window.DL 定义 + DL.store 经 DL 桥（SW chrome.storage）往返
    const probeCode = `
;(async () => {
  var mark = function (t) {
    var el = document.getElementById('${PROBE_MARKER_ID}')
    if (!el) { el = document.createElement('div'); el.id = '${PROBE_MARKER_ID}'; (document.body || document.documentElement).appendChild(el) }
    el.textContent = t
  }
  try {
    if (!window.DL || !window.DL.info) return mark('DL_MISSING')
    await DL.store.set('e2e-ok', 'yes')
    var v = await DL.store.get('e2e-ok')
    mark(v === 'yes' ? 'DL_OK' : 'DL_BAD_VALUE:' + String(v))
  } catch (e) { mark('DL_FAIL:' + ((e && e.message) || e)) }
})()
`
    const updated = await sendToSw<{ registerError?: string; warnings?: string[] }>(messenger!, {
      kind: 'userscript:updateFiles',
      uuid,
      files: { 'main.js': probeCode },
      entry: 'main.js',
      bundle: { code: probeCode, builtAt: Date.now() },
    })
    expect(updated.ok, `userscript:updateFiles 失败：${updated.ok ? '' : updated.error}`).toBe(true)
    if (updated.ok) {
      expect(updated.data.registerError, '重注册不应报错').toBeUndefined()
    }

    // 3. 打开探针页，等脚本标记结果（runAt document_end）
    const page = await context!.newPage()
    await page.goto(`http://127.0.0.1:${probePort}/probe.html`)
    await expect(page.locator(`#${PROBE_MARKER_ID}`)).toHaveText('DL_OK', { timeout: 20_000 })
    await page.close()

    // 4. 清理：删除探针脚本（注销 + 状态库 + git 仓 + DL.store 值）
    const removed = await sendToSw<void>(messenger!, { kind: 'userscript:remove', uuid })
    expect(removed.ok, `userscript:remove 失败：${removed.ok ? '' : removed.error}`).toBe(true)
  })
})
