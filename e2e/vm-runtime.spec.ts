// VM 注入链的真机验证（第 1 步）。
//
// 目标：把 VM 的两支注入件（`injected` / `injected-web`）挂进扩展，断言它们能在真实 Chrome 里
// 注册、注入、并跟 SW 通上话。**SW 侧只答一份空的 `GetInjected`**（无脚本）—— 这一步不看脚本
// 有没有跑，只看「注入链本身活着」：产物能被注册、没被页面 CSP 拦掉、`injected` 起得来、
// 消息能到 SW。
//
// 两个刻意的选择：
//   · **独立 profile**：新库为空 → 我们自己的脚本一条都没注册（relay 件也不在场），页面里只有
//     VM 这条链路，避免两条链路的注入件在同帧互相干扰，也免去清理步骤。
//   · **产物拷进扩展产物目录**：`chrome.userScripts.register` 的 `js: [{ file }]` 只能引用扩展内的
//     文件。这是验证用的临时落点（每次跑前重拷），不是正式接入方式。
//
// 桩为什么把日志写进 storage.session：SW 会被浏览器回收，回收后我们 evaluate 挂上的 listener
// 随之消失（SW 重启只重跑扩展自己的代码）。session 存储跨 SW 重启保留，「桩被问到过」记在那里
// 才读得回来。
import { test, expect, type BrowserContext, type Page, type Worker } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import * as http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EXTENSION_PATH,
  enableUserScripts,
  extensionIdFromServiceWorker,
  getServiceWorker,
  launchExtensionContext,
} from './extension'

/** gm-runtime 包产出的注入件 */
const RUNTIME_DIST = resolve(fileURLToPath(new URL('../packages/gm-runtime/dist', import.meta.url)))
/** 注入件在扩展内的落点（file 路径相对扩展根） */
const DEST_REL = 'gm-runtime'
const DEST = join(EXTENSION_PATH, DEST_REL)
/** 注册顺序照 VM 的 registerInjector：先内核源码载体，再宿主 */
const INJECTOR_ENTRIES = ['injected-web', 'injected']
/** 注册 id（VM 用的是 '1001'，这里给个自述名，避免与它混） */
const API_ID = 'gm-runtime-probe'
const LOG_KEY = '__gmRuntimeProbeLog'

/**
 * 注入件是否已构建。
 *
 * VM 源码是 vendored 且不入库（见 packages/gm-runtime/README.md），所以**干净 clone / CI 上
 * `dist` 是空的** —— 那种情况整条用例跳过，免得把 CI 门禁拖红（等正式接入后再让它成为硬前置）。
 */
const HAS_INJECTORS = INJECTOR_ENTRIES.every((n) => existsSync(join(RUNTIME_DIST, n, `${n}.js`)))

test.describe.serial('VM 注入链（真机）', () => {
  let context: BrowserContext | undefined
  let sw: Worker | undefined
  let profileDir = ''
  let server: http.Server | undefined
  let port = 0

  test.beforeAll(async () => {
    // 干净 clone / CI 上没有产物：什么都不做，用例在下面 skip
    if (!HAS_INJECTORS) return

    // 注入件就位（每次跑前重拷，避免旧产物残留误导结论）
    mkdirSync(DEST, { recursive: true })
    for (const name of INJECTOR_ENTRIES) {
      copyFileSync(join(RUNTIME_DIST, name, `${name}.js`), join(DEST, `${name}.js`))
    }

    profileDir = mkdtempSync(join(tmpdir(), 'duoling-vm-e2e-'))

    // Phase A：程序化打开 userScripts 开关（随 profile 持久化）—— 与 smoke / gm-matrix 同一套
    const bootCtx = await launchExtensionContext(profileDir)
    await enableUserScripts(bootCtx, extensionIdFromServiceWorker(await getServiceWorker(bootCtx)))
    await bootCtx.close()

    // Phase B：同 profile 重启，开关生效
    context = await launchExtensionContext(profileDir)
    sw = await getServiceWorker(context)

    // 注册两支注入件（注册本身持久化进 profile，之后每个页面加载都会注入）
    const registered = await sw.evaluate(
      async ({ id, files }) => {
        try {
          // messaging 必须开 —— 否则 USER_SCRIPT 世界里的 injected 没有 chrome.runtime，
          // 整条桥静默失效（与扩展自研链路同一个前提）
          await chrome.userScripts.configureWorld({ messaging: true })
          await chrome.userScripts.unregister({ ids: [id] }).catch(() => {})
          await chrome.userScripts.register([
            {
              id,
              runAt: 'document_start',
              allFrames: true,
              matches: ['<all_urls>'],
              js: files.map((file) => ({ file })),
            },
          ])
          return { ok: true as const }
        } catch (e) {
          return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
        }
      },
      { id: API_ID, files: INJECTOR_ENTRIES.map((n) => `${DEST_REL}/${n}.js`) },
    )
    expect(registered.ok, `注册注入件失败：${registered.ok ? '' : registered.error}`).toBe(true)

    // 本地探针页（不依赖外网）：VM 注入件的 matches 是 <all_urls>，http://127.0.0.1 落在里面
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
    try { rmSync(DEST, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })

  /** 挂 GetInjected 桩（每次导航前都要重挂：SW 被回收后 listener 就没了） */
  async function installStub(): Promise<void> {
    await sw!.evaluate(async (logKey: string) => {
      await chrome.storage.session.set({ [logKey]: {} })
      const onMsg = (
        msg: { cmd?: string } | undefined,
        _sender: unknown,
        sendResponse: (r: unknown) => void,
      ) => {
        const cmd = msg?.cmd
        if (!cmd) return undefined
        chrome.storage.session.get(logKey).then((cur) => {
          const log = (cur[logKey] ?? {}) as Record<string, number>
          log[cmd] = (log[cmd] ?? 0) + 1
          chrome.storage.session.set({ [logKey]: log })
        })
        if (cmd === 'GetInjected') {
          // 最小响应：这个页面没有要注入的脚本（第 1 步只验链路，不验脚本）
          sendResponse({ scripts: [] })
          return true
        }
        return undefined
      }
      // ★ 必须挂 onUserScriptMessage：默认世界配了 `messaging: true` 之后，来自该世界的 user script
      // 发的 runtime.sendMessage 会被路由到这里，**而不是通用 onMessage**（扩展自研链路的
      // dl-bridge 吃的就是同一个机制）。两边都挂以兼容未配 messaging 的情形。
      const rt = chrome.runtime as unknown as {
        onUserScriptMessage?: { addListener: (cb: unknown) => void }
        onMessage: { addListener: (cb: unknown) => void }
      }
      rt.onUserScriptMessage?.addListener(onMsg)
      rt.onMessage.addListener(onMsg)
    }, LOG_KEY)
  }

  /** 读桩的调用日志（SW 侧证据，跨 SW 重启保留） */
  async function readLog(): Promise<Record<string, number>> {
    return sw!.evaluate(async (logKey: string) => {
      const cur = await chrome.storage.session.get(logKey)
      return (cur[logKey] ?? {}) as Record<string, number>
    }, LOG_KEY)
  }

  test('注入件注册成功、能在真机页面里起跑并问到 SW', async () => {
    test.skip(!HAS_INJECTORS, '本地未构建 gm-runtime 注入件（vendor 不入库，干净 clone / CI 上跳过）')
    test.skip(!sw, 'SW 未就绪')
    await installStub()

    // 注册确实生效（SW 侧的真相源）
    const ids = await sw!.evaluate(async (id: string) => {
      const list = await chrome.userScripts.getScripts()
      return list.map((s) => s.id)
    }, API_ID)
    console.log(`[E2E] 已注册的 userScripts：${JSON.stringify(ids)}`)
    expect(ids, '注入件应在注册表里').toContain(API_ID)

    const page: Page = await context!.newPage()
    const errors: string[] = []
    const logs: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
    await page.goto(`http://127.0.0.1:${port}/probe.html`, { waitUntil: 'load' })

    // 等 injected（USER_SCRIPT 世界）把 GetInjected 问到 SW —— 这是「注入链活着」的关键证据：
    // 产物被注册、没被 CSP 拦、宿主起得来、消息通道通。VM 的 sendMessageRetry 最多重试 10s。
    let log: Record<string, number> = {}
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      log = await readLog()
      if ((log.GetInjected ?? 0) > 0) break
      await page.waitForTimeout(500)
    }
    console.log(`[E2E] 桩收到的命令：${JSON.stringify(log)}`)
    expect(log.GetInjected, 'injected 应该向 SW 问过 GetInjected（没问到 = 宿主没起或桥不通）').toBeGreaterThan(0)

    console.log(`[E2E] 页面错误：${errors.length ? JSON.stringify(errors) : '无'}`)
    if (logs.length) console.log(`[E2E] 页面 console：\n${logs.slice(0, 20).join('\n')}`)
    await page.close()
  })
})
