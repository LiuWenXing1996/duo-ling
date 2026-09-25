// P4·A 安装流收口验证：用户脚本经 duo-ling 的创建 / 启用 / 关停消息，真正落进 VM 运行时并执行。
//
// 与 vm-runtime.spec.ts（直接 parseScript 种脚本）不同，本 spec 走**真实产品链路**：
//   popup 扩展页 → chrome.runtime.sendMessage → background onMessage
//     · userscript:createProject（enabled）  → 走 vmInstallScript → VM parseScript 落库
//     · userscript:toggle（关 / 开）          → 走 vmUninstallScript / registerOrLog
// 再打开本地探针页，验证脚本在页面里实际跑起来（VM 接管注入，旧自研引擎链路 background 已拔除）。
//
// 这是 Phase A 的验收：创建 / 启停不再依赖自研 engine.ts，全部经 VM 运行时。
import { test, expect, type BrowserContext, type Page, type Worker } from '@playwright/test'
import * as http from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  enableUserScripts,
  extensionIdFromServiceWorker,
  getServiceWorker,
  launchExtensionContext,
  openMessengerPage,
  sendToSw,
} from './extension'

/** 正式产物的落点（缺它 = 没跑过 `pnpm run build` 或 gm-runtime 未构建 → 整条跳过） */
const PUBLIC_RUNTIME = resolve(join('public', 'gm-runtime', 'sw.js'))

/** 探针脚本：@match 必须带端口（VM 端口语义，见 gm-runtime README 条目 15） */
const makeProbeScript = (port: number) => `\
// ==UserScript==
// @name vm-install-probe
// @match http://127.0.0.1:${port}/*
// @run-at document-start
// @inject-into page
// ==/UserScript==
document.documentElement.setAttribute('data-vm-install-probe', 'ran');
`

test.describe.serial('P4·A 安装流（创建/启停 → VM 真跑）', () => {
  let context: BrowserContext | undefined
  let sw: Worker | undefined
  let messenger: Page | undefined
  let scriptUuid = ''
  let profileDir = ''
  let server: http.Server | undefined
  let port = 0

  test.beforeAll(async () => {
    if (!existsSync(PUBLIC_RUNTIME)) return

    profileDir = mkdtempSync(join(tmpdir(), 'duoling-vm-install-e2e-'))

    // Phase A：程序化打开 userScripts 开关（随 profile 持久化）
    const bootCtx = await launchExtensionContext(profileDir)
    await enableUserScripts(bootCtx, extensionIdFromServiceWorker(await getServiceWorker(bootCtx)))
    await bootCtx.close()

    // Phase B：同 profile 重启，开关生效；SW 启动时 background.ts 已完成 VM 装配
    context = await launchExtensionContext(profileDir)
    sw = await getServiceWorker(context)
    messenger = await openMessengerPage(context, extensionIdFromServiceWorker(sw))

    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>vm install probe</title></head><body><h1>vm install probe</h1></body></html>')
    })
    port = await new Promise<number>((done) => {
      server!.listen(0, '127.0.0.1', () => done((server!.address() as { port: number }).port))
    })
  })

  test.afterAll(async () => {
    // 清理：删除建的脚本（标记 removed，VM 停注）
    if (sw && scriptUuid) {
      await sw.evaluate(() => Promise.resolve()).catch(() => {})
    }
    const withTimeout = (p: Promise<unknown> | undefined, ms: number) =>
      p ? Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve()
    try { await withTimeout(messenger?.close(), 10_000) } catch { /* 忽略 */ }
    try { await withTimeout(context?.close(), 30_000) } catch { /* 忽略 */ }
    try { server?.closeAllConnections() } catch { /* 忽略 */ }
    try { await withTimeout(new Promise<void>((r) => server?.close(() => r())), 5_000) } catch { /* 忽略 */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })

  /** VM 脚本库里是否存在带给定 uuid 的脚本（落库证据） */
  async function vmStoreHasUuid(uuid: string): Promise<boolean> {
    return sw!.evaluate((target: string) => {
      const g = globalThis as unknown as {
        // 注意：VM db.js 的 getScriptsByIdsOrAll 是**同步**函数（返回数组，非 Promise），
        // 与 vm-runtime-host 类型声明的「Promise | 数组」二态一致 —— 用 Array.isArray 兼容两种形态，
        // 不要直接 .then（同步数组无 then 会抛 "not a function"）。
        __gmRuntime?: { getScriptsByIdsOrAll: (x: null) => unknown }
      }
      if (!g.__gmRuntime) return false
      const list = g.__gmRuntime.getScriptsByIdsOrAll(null)
      if (!Array.isArray(list)) return false
      return list.some((s) => (s as { props?: { uuid?: string } }).props?.uuid === target)
    }, uuid)
  }

  test('经 createProject(enabled) 真实安装 → 脚本落 VM 库且在页面 MAIN 世界执行', async () => {
    test.skip(!existsSync(PUBLIC_RUNTIME), '本地未构建 gm-runtime 正式产物（干净 clone / CI 上跳过）')
    test.skip(!messenger, 'messenger 未就绪')

    // 1) 真实产品链路：创建并启用一个脚本（background onMessage → vmInstallScript → VM parseScript 落库）
    const created = await sendToSw<{ uuid: string; registerError?: string; warnings?: string[] }>(
      messenger!,
      { kind: 'userscript:createProject', name: 'vm-install-probe', code: makeProbeScript(port), enabled: true },
    )
    expect(created.ok, `userscript:createProject 应成功：${JSON.stringify(created)}`).toBe(true)
    if (!created.ok) return
    scriptUuid = created.data.uuid
    expect(created.data.registerError, 'VM 安装不应报错').toBeUndefined()
    console.log(`[E2E] 已创建并启用脚本 uuid=${scriptUuid}`)

    // 2) 落库证据：VM 脚本库里能按 uuid 查到（说明走的是 VM 运行时，不是旧自研引擎）
    await expect
      .poll(() => vmStoreHasUuid(scriptUuid), { timeout: 10_000, message: 'VM 脚本库里没查到该 uuid（未落库？）' })
      .toBe(true)

    // 3) 真跑证据：打开探针页，脚本在页面里写 DOM 属性（page.evaluate 同 DOM 即可读到）
    const page = await context!.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String((e as Error)?.stack || e)))
    await page.goto(`http://127.0.0.1:${port}/probe.html`, { waitUntil: 'load' })
    try {
      await expect
        .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-vm-install-probe')), {
          timeout: 15_000,
          message: `脚本没跑起来。页面错误：${JSON.stringify(errors)}`,
        })
        .toBe('ran')
    } catch {
      const dump = await page.evaluate(() => ({
        url: location.href,
        attrs: [...document.documentElement.attributes].map((a) => `${a.name}=${a.value.slice(0, 40)}`),
      }))
      console.log(`[E2E] 页面现场：${JSON.stringify(dump)}`)
      await page.close()
      throw new Error('VM 脚本未在页面执行（现场已打印）')
    }
    await page.close()
  })

  test('toggle 关停 → 不再注入；再启用 → 重新注入', async () => {
    test.skip(!messenger || !scriptUuid, '前置创建用例未就绪')

    // 1) 关停：走 vmUninstallScript（标记 removed）
    const off = await sendToSw<{ registerError?: string }>(messenger!, {
      kind: 'userscript:toggle', uuid: scriptUuid, enabled: false,
    })
    expect(off.ok, `toggle(off) 应成功：${JSON.stringify(off)}`).toBe(true)

    // 2) 新页面里脚本不应再跑（VM 标记 removed，GetInjected 不再包含它）
    const pageOff = await context!.newPage()
    await pageOff.goto(`http://127.0.0.1:${port}/probe-off.html`, { waitUntil: 'load' })
    await pageOff.waitForTimeout(6_000)
    const attrOff = await pageOff.evaluate(() => document.documentElement.getAttribute('data-vm-install-probe'))
    console.log(`[E2E] 关停后页面属性：${attrOff ?? 'null（预期：未注入）'}`)
    expect(attrOff, '关停后脚本不应再注入执行').toBeNull()
    await pageOff.close()

    // 3) 重新启用：走 registerOrLog → vmInstallScript
    const on = await sendToSw<{ registerError?: string }>(messenger!, {
      kind: 'userscript:toggle', uuid: scriptUuid, enabled: true,
    })
    expect(on.ok, `toggle(on) 应成功：${JSON.stringify(on)}`).toBe(true)
    if (on.ok) expect(on.data.registerError, '重新启用不应报错').toBeUndefined()

    // 4) 新页面里脚本应重新跑起来
    const pageOn = await context!.newPage()
    const errors: string[] = []
    pageOn.on('pageerror', (e) => errors.push(String((e as Error)?.stack || e)))
    await pageOn.goto(`http://127.0.0.1:${port}/probe-on.html`, { waitUntil: 'load' })
    try {
      await expect
        .poll(() => pageOn.evaluate(() => document.documentElement.getAttribute('data-vm-install-probe')), {
          timeout: 15_000,
          message: `重新启用后脚本没跑起来。页面错误：${JSON.stringify(errors)}`,
        })
        .toBe('ran')
    } catch {
      await pageOn.close()
      throw new Error('重新启用后 VM 脚本未执行')
    }
    await pageOn.close()
  })
})
