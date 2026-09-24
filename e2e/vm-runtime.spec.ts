// VM 运行时正式接入的真机验证。
//
// 与早期验证形态（外挂 inline 产物 / 手工拷文件）不同：库已由 `pnpm run build` 正式打进扩展
// （public/gm-runtime/ → background.ts 顶层 importScripts + 垫片装配，见
// src/lib/userscripts/vm-runtime-host.ts）。本 spec 只验证端到端语义：
//   种脚本（VM 真实 parseScript → db → tester）→ 页面加载 → GetInjected 真匹配 → 脚本在
//   页面 MAIN 世界执行 → Run 回执到达 SW。
//
// 种脚本用 SW 里的 globalThis.__gmRuntime（库产物挂在上面）—— 正式接入后 VM 库的内容来源
// 属于「脚本库迁移」的范畴（见 P4），验证阶段由测试直接种入。
// profile 是全新的（自研脚本库为空）→ 页面里只有 VM 这一条链路，避免两条链路互相干扰。
import { test, expect, type BrowserContext, type Page, type Worker } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import * as http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  enableUserScripts,
  extensionIdFromServiceWorker,
  getServiceWorker,
  launchExtensionContext,
} from './extension'

/** 正式产物的落点（缺它 = 没跑过 `pnpm run build` 或 gm-runtime 未构建 → 整条跳过） */
const PUBLIC_RUNTIME = resolve(join('public', 'gm-runtime', 'sw.js'))
const VM_ID = '1001'

/** 种进 VM 脚本库的探针脚本。@match 必须带端口（VM 的端口语义，见 gm-runtime README 条目 15） */
const makeProbeScript = (port: number) => `\
// ==UserScript==
// @name vm-e2e-probe
// @match http://127.0.0.1:${port}/*
// @run-at document-start
// @inject-into page
// ==/UserScript==
document.documentElement.setAttribute('data-vm-runtime-probe', 'ran');
`

test.describe.serial('VM 运行时（正式接入·真机）', () => {
  let context: BrowserContext | undefined
  let sw: Worker | undefined
  let profileDir = ''
  let server: http.Server | undefined
  let port = 0

  test.beforeAll(async () => {
    // 正式产物不在（干净 clone 未构建 / CI）：整条跳过，不拖 CI 门禁
    if (!existsSync(PUBLIC_RUNTIME)) return

    profileDir = mkdtempSync(join(tmpdir(), 'duoling-vm-e2e-'))

    // Phase A：程序化打开 userScripts 开关（随 profile 持久化）—— 与 smoke / gm-matrix 同一套
    const bootCtx = await launchExtensionContext(profileDir)
    await enableUserScripts(bootCtx, extensionIdFromServiceWorker(await getServiceWorker(bootCtx)))
    await bootCtx.close()

    // Phase B：同 profile 重启，开关生效；SW 启动时 background.ts 已完成 VM 装配
    context = await launchExtensionContext(profileDir)
    sw = await getServiceWorker(context)

    // 本地探针页（不依赖外网）
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>vm probe</title></head><body><h1>vm probe</h1></body></html>')
    })
    port = await new Promise<number>((done) => {
      server!.listen(0, '127.0.0.1', () => done((server!.address() as { port: number }).port))
    })
  })

  test.afterAll(async () => {
    const withTimeout = (p: Promise<unknown> | undefined, ms: number) =>
      p ? Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve()
    try { await withTimeout(context?.close(), 30_000) } catch { /* 忽略 */ }
    try { server?.closeAllConnections() } catch { /* 忽略 */ }
    try { await withTimeout(new Promise<void>((r) => server?.close(() => r())), 5_000) } catch { /* 忽略 */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })

  /** 读装配与命令日志（SW 侧证据，跨 SW 重启保留） */
  async function readLog(): Promise<{ cmd?: Record<string, number>; err?: Record<string, string> }> {
    return sw!.evaluate(async () => {
      const cur = await chrome.storage.session.get(['__vmCmdLog', '__vmCmdErr'])
      return {
        cmd: cur.__vmCmdLog as Record<string, number> | undefined,
        err: cur.__vmCmdErr as Record<string, string> | undefined,
      }
    })
  }

  test('正式装配：种脚本 → GetInjected 真匹配 → 脚本在页面跑起来', async () => {
    test.skip(!existsSync(PUBLIC_RUNTIME), '本地未构建 gm-runtime 正式产物（干净 clone / CI 上跳过）')
    test.skip(!sw, 'SW 未就绪')

    // 装配证据：库在、VM 注入器已注册
    const installed = await sw!.evaluate((vmId: string) => {
      const g = globalThis as unknown as { __gmRuntime?: unknown }
      return chrome.userScripts.getScripts({ ids: [vmId] }).then((list) => ({
        libLoaded: !!g.__gmRuntime,
        registered: list.map((s) => s.id),
      }))
    }, VM_ID)
    console.log(`[E2E] 装配状态：${JSON.stringify(installed)}`)
    const hostErr = await sw!.evaluate(async () => {
      const cur = await chrome.storage.session.get('__vmHostErr')
      return cur.__vmHostErr as string | undefined
    })
    expect(installed.libLoaded, 'gm-runtime 库应已加载').toBe(true)
    // 逐步诊断：与 host 的 initVmRuntime 相同的调用序列，哪一步失败一目了然
    const steps = await sw!.evaluate(async (vmId: string) => {
      const out: string[] = []
      const tryStep = async (name: string, fn: () => Promise<unknown>) => {
        try {
          await fn()
          out.push(`${name}:OK`)
        } catch (e) {
          out.push(`${name}:ERR ${String((e as Error)?.message || e)}`)
        }
      }
      await tryStep('configureWorld', () =>
        chrome.userScripts.configureWorld({
          messaging: true,
          csp: "script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline' data: blob:",
          worldId: 'vm',
        }))
      await tryStep('unregister', () =>
        (chrome.userScripts as unknown as { unregister: (o?: unknown) => Promise<void> })
          .unregister({ ids: [vmId] }).catch(() => {}))
      await tryStep('register', () =>
        (chrome.userScripts as unknown as { register: (s: unknown) => Promise<void> }).register([
          {
            id: vmId,
            runAt: 'document_start',
            allFrames: true,
            matches: ['<all_urls>'],
            worldId: 'vm',
            js: [{ file: 'gm-runtime/injected-web.js' }, { file: 'gm-runtime/injected.js' }],
          },
        ]))
      const list = await chrome.userScripts.getScripts({ ids: [vmId] })
      out.push(`getScripts:${list.map((s) => s.id).join(',') || 'EMPTY'}`)
      return out
    }, VM_ID)
    console.log(`[E2E] 逐步装配诊断：${JSON.stringify(steps)}`)
    // host 的异步装配与上面的诊断步骤殊途同归 —— 轮询等注册就绪
    await expect
      .poll(
        async () =>
          sw!.evaluate(async (vmId: string) =>
            (await chrome.userScripts.getScripts({ ids: [vmId] })).map((s) => s.id), VM_ID),
        { timeout: 10_000, message: `VM 注入器未注册；装配错误：${hostErr ?? '（无记录）'}；诊断：${JSON.stringify(steps)}` },
      )
      .toContain(VM_ID)

    // 种脚本（幂等性靠 VM 自己的同名冲突检查；失败即装配不完整）
    const seeded = await sw!.evaluate(async (script: string) => {
      const g = globalThis as unknown as {
        __gmRuntime?: {
          parseScript: (src: { code: string }) => Promise<{ props?: { id?: number } }>
          dispatch: (msg: { cmd?: string }, src: unknown) => Promise<unknown>
        }
      }
      const mod = g.__gmRuntime
      if (!mod) return 'NO_LIB'
      const parsed = await mod.parseScript({ code: script })
      return JSON.stringify(parsed)
    }, makeProbeScript(port))
    console.log(`[E2E] parseScript 结果：${seeded}`)
    expect(seeded, '种脚本应成功').toContain('"props"')

    // 给 dispatch 的应答挂上日志（storage.session，跨 SW 重启可读）——正式链路里由
    // vm-runtime-host 的 listener 记录
    await sw!.evaluate(() => {
      void chrome.storage.session.set({ __vmCmdLog: {}, __vmCmdErr: {} })
    })

    const page: Page = await context!.newPage()
    const errors: string[] = []
    const logs: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
    await page.goto(`http://127.0.0.1:${port}/probe.html`, { waitUntil: 'load' })

    // VM 注入件问 SW（GetInjected 到达 = 注入链活着；evaluate 喂数据在 host 模块里）
    let log: { cmd?: Record<string, number>; err?: Record<string, string> } = {}
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      log = await readLog()
      if ((log.cmd?.GetInjected ?? 0) > 0) break
      await page.waitForTimeout(500)
    }
    console.log(`[E2E] 命令日志：${JSON.stringify(log.cmd)}｜dispatch 错误：${JSON.stringify(log.err) ?? '无'}`)
    expect(log.cmd?.GetInjected, 'GetInjected 应到达 SW').toBeGreaterThan(0)

    console.log(`[E2E] 页面错误：${errors.length ? JSON.stringify(errors) : '无'}`)
    if (logs.length) console.log(`[E2E] 页面 console（共 ${logs.length} 条）：\n${logs.slice(0, 40).join('\n')}`)

    // 分水岭：VM 真链路交出的脚本在页面 MAIN 世界执行（脚本写 DOM 属性；page.evaluate 同世界读得到）
    await expect
      .poll(
        () => page.evaluate(() => document.documentElement.getAttribute('data-vm-runtime-probe')),
        {
          timeout: 15_000,
          message: `脚本没跑起来。页面错误：${JSON.stringify(errors)}｜dispatch 错误：${JSON.stringify(log.err)}`,
        },
      )
      .toBe('ran')
    await page.close()
  })
})
