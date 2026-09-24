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
/** sw 库产物（VM background 的库形态装配，见 packages/gm-runtime/entry/sw.js） */
const SW_LIB = 'sw'
/** 注册 id（VM 用的是 '1001'，这里给个自述名，避免与它混） */
const API_ID = 'gm-runtime-probe'
const LOG_KEY = '__gmRuntimeProbeLog'
/** 种进 VM 脚本库的探针脚本：带 @match，走 VM 真实的 parseScript → db → tester 匹配链 */
const PROBE_SCRIPT = `\
// ==UserScript==
// @name vm-e2e-probe
// @match http://127.0.0.1/*
// @run-at document-start
// ==/UserScript==
document.documentElement.setAttribute('data-vm-runtime-probe', 'ran');
`

/**
 * 产物是否已构建。
 *
 * VM 源码是 vendored 且不入库（见 packages/gm-runtime/README.md），所以**干净 clone / CI 上
 * `dist` 是空的** —— 那种情况整条用例跳过，免得把 CI 门禁拖红（等正式接入后再让它成为硬前置）。
 */
const HAS_BUILD =
  INJECTOR_ENTRIES.every((n) => existsSync(join(RUNTIME_DIST, n, `${n}.js`))) &&
  existsSync(join(RUNTIME_DIST, SW_LIB, `${SW_LIB}.js`))

/** sw 库产物的模块形状（见 packages/gm-runtime/entry/sw.js） */
type RuntimeMod = {
  initGM: () => Promise<void>
  dispatch: (msg: { cmd?: string; url?: string; top?: number }, src: unknown) => Promise<unknown>
  parseScript: (src: { code: string }) => Promise<{ id?: number }>
}

test.describe.serial('VM 注入链（真机）', () => {
  let context: BrowserContext | undefined
  let sw: Worker | undefined
  let profileDir = ''
  let server: http.Server | undefined
  let port = 0

  test.beforeAll(async () => {
    // 干净 clone / CI 上没有产物：什么都不做，用例在下面 skip
    if (!HAS_INJECTORS) return

    // 注入件与 sw 库产物就位（每次跑前重拷，避免旧产物残留误导结论）
    mkdirSync(DEST, { recursive: true })
    for (const name of [...INJECTOR_ENTRIES, SW_LIB]) {
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
          // messaging + csp 都要配（照 VM 的 registerInjector）：messaging 给 USER_SCRIPT 世界
          // 开 chrome.runtime；csp 换掉该世界的默认 CSP —— 否则注入件往页面注的内联 script
          //（vault iframe + 内核）会被「script-src 'self' …」拦掉，握手完不成、脚本静默被丢。
          await chrome.userScripts.configureWorld({
            messaging: true,
            csp: "script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline' data: blob:",
          })
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

  /**
   * 装配 VM 的真实 background 库（第二批的核心验证，替代第一批的硬编码桩）：
   *   ① 动态 import sw 库产物（VM 的 db/preinject/tab-redirector 装配体）—— import 即初始化
   *      （db.js 模块加载时就 initializeDatabase 并 resolve init）
   *   ② initGM 等待初始化链完成，然后用 VM 真实的 parseScript 把探针脚本种进脚本库
   *   ③ 把 onUserScriptMessage 接到库的 dispatch 上 —— 响应信封照 VM 的 browser.js wrapResponse
   *      （`[result ?? null, error]`，content 层的 unwrapResponse 读 [0]/[1]）
   * 此时 GetInjected 走的是 VM 的完整真链路：tester 匹配 URL → preinject 准备注入描述 →
   * 返回 VMInjection —— 桩里那些手工构造的字段一个都不再需要。
   */
  async function installRuntime(): Promise<string> {
    const seeded = await sw!.evaluate(async ({ logKey, script }: { logKey: string; script: string }) => {
      await chrome.storage.session.set({ [logKey]: {} })
      // 防重挂：SW 同一生命周期内库模块 import 有缓存，listener 用全局标记防重复挂接
      const g = globalThis as unknown as {
        __vmRuntimeInstalled?: Promise<RuntimeMod>
      }
      if (!g.__vmRuntimeInstalled) {
        g.__vmRuntimeInstalled = (async (): Promise<RuntimeMod> => {
          const mod = (await import(chrome.runtime.getURL('gm-runtime/sw.js'))) as RuntimeMod
          await mod.initGM()
          const rt = chrome.runtime as unknown as {
            onUserScriptMessage?: { addListener: (cb: unknown) => void }
          }
          rt.onUserScriptMessage?.addListener((msg, sender, sendResponse) => {
            const cmd = (msg as { cmd?: string } | undefined)?.cmd
            if (!cmd) return undefined
            chrome.storage.session.get(logKey).then((cur) => {
              const log = (cur[logKey] ?? {}) as Record<string, number>
              log[cmd] = (log[cmd] ?? 0) + 1
              chrome.storage.session.set({ [logKey]: log })
            })
            const p = mod.dispatch(msg as { cmd?: string }, sender)
            if (p instanceof Promise) {
              p.then(
                (res) => sendResponse([res ?? null, false]),
                (err) => sendResponse([null, [String(err), '']]),
              )
              return true
            }
            return undefined
          })
          return mod
        })()
      }
      const mod = await g.__vmRuntimeInstalled
      // 种脚本（幂等性靠 VM 自己：同名 @name/@namespace 会命中它的 namespace 冲突检查）
      const parsed = await mod.parseScript({ code: script })
      return JSON.stringify(parsed)
    }, { logKey: LOG_KEY, script: PROBE_SCRIPT })
    return seeded
  }

  /** 读桩的调用日志（SW 侧证据，跨 SW 重启保留） */
  async function readLog(): Promise<Record<string, number>> {
    return sw!.evaluate(async (logKey: string) => {
      const cur = await chrome.storage.session.get(logKey)
      return (cur[logKey] ?? {}) as Record<string, number>
    }, LOG_KEY)
  }

  test('VM background 装配进 SW 后：种脚本 → GetInjected 真匹配 → 脚本在页面跑起来', async () => {
    test.skip(!HAS_BUILD, '本地未构建 gm-runtime 产物（vendor 不入库，干净 clone / CI 上跳过）')
    test.skip(!sw, 'SW 未就绪')
    const seeded = await installRuntime()
    console.log(`[E2E] parseScript 结果：${seeded}`)

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
    // MAIN 世界的诊断钩子（每次导航前执行）：记录所有 dispatchEvent 的事件名 + 主世界错误。
    // 内核 fire 握手事件走 window.dispatchEvent，能在这里看到它到底 fire 没 fire。
    await page.addInitScript(() => {
      const w = window as unknown as {
        __diag: { dispatched: string[]; errs: string[] }
        __vmInjected?: boolean
      }
      w.__diag = { dispatched: [], errs: [] }
      const orig = EventTarget.prototype.dispatchEvent
      EventTarget.prototype.dispatchEvent = function (e: Event) {
        w.__diag.dispatched.push(e.type)
        if (w.__diag.dispatched.length > 40) w.__diag.dispatched.shift()
        return orig.call(this, e)
      }
      window.addEventListener('error', (e) => {
        w.__diag.errs.push((e as ErrorEvent).message)
        if (w.__diag.errs.length > 20) w.__diag.errs.shift()
      })
    })
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
    if (logs.length) console.log(`[E2E] 页面 console（共 ${logs.length} 条）：\n${logs.slice(0, 80).join('\n')}`)

    // 这一步的分水岭：脚本已种进 VM 的脚本库，GetInjected 走 VM 真实的匹配与注入准备链路，
    // 断言它真的在页面 MAIN 世界里执行了（脚本往 documentElement 写了个属性；
    // page.evaluate 也跑在 MAIN 世界，读得到）。
    await expect
      .poll(
        () => page.evaluate(() => document.documentElement.getAttribute('data-vm-runtime-probe')),
        {
          timeout: 15_000,
          message: `脚本没跑起来（属性没写上）。页面错误：${JSON.stringify(errors)}｜console：${logs.slice(0, 6).join(' / ')}`,
        },
      )
      .toBe('ran')
    await page.close()
  })
})
