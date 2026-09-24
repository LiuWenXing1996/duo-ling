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

  /** 挂 GetInjected 桩（每次导航前都要重挂：SW 被回收后 listener 就没了） */
  async function installStub(): Promise<void> {
    await sw!.evaluate(async (logKey: string) => {
      await chrome.storage.session.set({ [logKey]: {} })
      const onMsg = (
        msg: { cmd?: string } | undefined,
        sender: unknown,
        sendResponse: (r: unknown) => void,
      ) => {
        const cmd = msg?.cmd
        if (!cmd) return undefined
        const senderTabId = (sender as { tab?: { id?: number } } | undefined)?.tab?.id ?? -1
        chrome.storage.session.get(logKey).then((cur) => {
          const log = (cur[logKey] ?? {}) as Record<string, number>
          log[cmd] = (log[cmd] ?? 0) + 1
          chrome.storage.session.set({ [logKey]: log, __vmProbeTabId: senderTabId })
        })
        if (cmd === 'ping') {
          sendResponse(['pong', 0])
          return true
        }
        if (cmd === 'GetInjected') {
          // 一条会写 DOM 的最小脚本，用来证明「脚本真的在页面里跑起来了」。
          // 结构照 VM 的 `prepareScript`（见 vendor 的 background/utils/preinject-prepare.js）：
          //   · `code` 可以是**分片数组**（VM 就是这么拼 @require + 源码 + 收尾的，content 层按数组 append）
          //   · `gmi` 只需 scriptWillUpdate / uuid 两个字段（其余由内核的 makeGmApiWrapper 补）
          //   · `meta.grant` 必需（content 层的 triageScript 会读 `meta.grant.length`）
          //   · `cache` 必需（content 层 `setPrototypeOf(bridge.cache = data.cache, null)`，缺了会抛）
          //   · `injectInto: 'page'` 才注入页面 MAIN 世界
          //   · `runAt: 'start'` 才会在第一轮就注入 —— content 层的 end/idle 批次只在响应带 `more`
          //     （第二轮数据）时才跑，这里不提供 more，所以只有 start 会被处理
          const injection = {
            scripts: [
              {
                id: 1,
                code: ['document.documentElement.setAttribute("data-vm-runtime-probe", "ran");\n'],
                displayName: 'gm-runtime-probe',
                gmi: { scriptWillUpdate: false, uuid: 'gm-runtime-probe' },
                key: { data: 'dprobe1', win: 'wprobe1' },
                meta: { name: 'gm-runtime-probe', grant: [], unwrap: false },
                metaStr: ['', 0, 0],
                pathMap: {},
                runAt: 'start',
                injectInto: 'page',
              },
            ],
            cache: {},
            ids: [1],
            runAt: { 1: 'start' },
            value: {},
            valueIds: [],
            errors: '',
            // ★ `page: true` 是必需的开关：content 层只有看到它才会启动「页面可注入性」握手
            // （injectPageSandbox → vault/handshake → 把内核注进 MAIN 世界）。
            // 漏了它，triageScript 会把脚本判成「坏 realm」整条丢弃 —— 且页面零报错，极难查。
            page: true,
            sessionId: 'gm-runtime-probe',
            info: { ua: {}, gmi: { downloadMode: 'browser', isIncognito: false } },
          }
          // ★ VM 的 browser.js 会对响应解包（unwrapResponse 读信封的 [0]=结果、[1]=错误标记）：
          // 必须给 `[result, 0]` 数组形状。裸对象会被 resolve 成 undefined，又落到错误分支被
          // init().catch(…) 静默吞掉 —— 上一轮「零报错但脚本没跑」就是它。
          // 双通道应答（VM 原生就有两条，赛跑先到先得）：
          //   ① messaging：sendResponse 回 [injection, 0] 信封（browser.js 的 unwrapResponse 读 [0]/[1]）
          //   ② registerScriptData：userScripts.execute 把 window.Violentmonkey(injection) 喂给
          //      content 层在 getRegistration 里挂的等待器（preinject-core.js 的 INJECTED_DATA_ID
          //      同款机制）—— 必须 world:'USER_SCRIPT'，execute 默认是 MAIN 世界。
          // 输的那条会报「window.Violentmonkey is not a function」，无害，不当作失败。
          chrome.userScripts.execute({
            js: [{ code: `window['Violentmonkey'](${JSON.stringify(injection)})` }],
            target: { tabId: senderTabId },
            world: 'USER_SCRIPT',
          }).catch((e) => console.error('[vm-probe] execute 失败', String(e)))
          sendResponse([injection, 0])
          return true
        }
        return undefined
      }
      // ★ 只能挂 onUserScriptMessage：默认世界配了 `messaging: true` 之后，来自该世界的
      // runtime.sendMessage 走这条事件（扩展自研链路的 dl-bridge 吃的也是它）。
      // ⚠️ 千万别再挂通用 onMessage —— 两个事件都会收到同一条消息，而扩展自己的 onMessage
      // 监听器会对不认识的消息「返回 true 占住响应权」，VM 的 sendResponse 就被吞掉，
      // 表现为 sendMessageRetry 永远 pending（消息被问多次、日志链停在 await）。
      const rt = chrome.runtime as unknown as {
        onUserScriptMessage?: { addListener: (cb: unknown) => void }
      }
      rt.onUserScriptMessage?.addListener(onMsg)
    }, LOG_KEY)
  }

  /** 读桩的调用日志（SW 侧证据，跨 SW 重启保留） */
  async function readLog(): Promise<Record<string, number>> {
    return sw!.evaluate(async (logKey: string) => {
      const cur = await chrome.storage.session.get(logKey)
      return (cur[logKey] ?? {}) as Record<string, number>
    }, LOG_KEY)
  }

  test('注入件注册成功、能跟 SW 通上话、并让一条脚本在页面里跑起来', async () => {
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

    // 诊断：把每个 frame 上 VM content 层留下的插桩痕迹读出来（见 packages/gm-runtime 的插桩脚本）。
    // 走 DOM 属性而不是 console —— content 层在隔离世界，它的 console 不会进 page.on('console')。
    await page.waitForTimeout(4000)
    for (const f of page.frames()) {
      try {
        const probe = await f.evaluate(() => ({
          log: document.documentElement?.getAttribute('data-vm-probe') ?? null,
          ran: document.documentElement?.getAttribute('data-vm-runtime-probe') ?? null,
          frames: window.frames.length,
        }))
        console.log(`[E2E] frame ${f === page.mainFrame() ? '(main)' : f.url()} → ${JSON.stringify(probe)}`)
      } catch (e) {
        console.log(`[E2E] frame ${f.url()} → 读取失败：${String(e)}`)
      }
    }

    // ping/pong 单测：user script 世界 → SW 桩 → sendResponse 这条响应通道本身是否可用。
    // 探针用 chrome.userScripts.execute 注入（它默认就跑在与注入件相同的 USER_SCRIPT 世界）。
    const tabId = await sw!.evaluate(async () => {
      const cur = await chrome.storage.session.get('__vmProbeTabId')
      return (cur.__vmProbeTabId ?? -1) as number
    })
    console.log(`[E2E] 消息来源 tabId：${tabId}`)
    if (tabId > 0) {
      await sw!.evaluate(async (tid: number) => {
        await chrome.userScripts.execute({
          js: [{
            code: `chrome.runtime.sendMessage({cmd:'ping'}).then((r) => document.documentElement.setAttribute('data-ping', JSON.stringify(r))).catch((e) => document.documentElement.setAttribute('data-ping', 'ERR:' + e))`,
          }],
          target: { tabId: tid },
        })
      }, tabId)
      await page.waitForTimeout(1500)
      const pong = await page.evaluate(() => document.documentElement.getAttribute('data-ping'))
      console.log(`[E2E] ping/pong：${pong}`)
    }

    // 这一步的分水岭：桩给了一条真实脚本，断言它真的在页面 MAIN 世界里执行了。
    // 脚本往 documentElement 写了个属性；page.evaluate 也跑在 MAIN 世界，读得到。
    // 诊断信息带上 message —— 断言抛错时后面的 log 不会执行，光看结果会瞎猜。
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
