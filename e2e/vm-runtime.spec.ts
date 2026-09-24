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
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
const API_ID = '1001'
const LOG_KEY = '__gmRuntimeProbeLog'
/** 种进 VM 脚本库的探针脚本：走 VM 真实的 parseScript → db → tester 匹配链。
 * @match 必须带端口 —— VM 的 URL 解析（RE_URL_PARTS 的 `[^/]*`）把 host+port 一起匹配，
 * 与 Chrome 原生 match pattern「忽略端口」的语义不同（正式的差异登记条目）。 */
const makeProbeScript = (port: number) => `\
// ==UserScript==
// @name vm-e2e-probe
// @match http://127.0.0.1:${port}/*
// @run-at document-start
// @inject-into page
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
    if (!HAS_BUILD) return

    // 注入件与 sw 库产物就位（每次跑前重拷，避免旧产物残留误导结论）
    mkdirSync(DEST, { recursive: true })
    for (const name of [...INJECTOR_ENTRIES, SW_LIB]) {
      copyFileSync(join(RUNTIME_DIST, name, `${name}.js`), join(DEST, `${name}.js`))
    }

    // 把 sw 库挂进 SW 的顶层评估。两个已踩过的坑：
    //   · MV3 SW 禁动态 import()（ServiceWorker spec）→ 不能用 import()
    //   · Chrome 对 SW 的 importScripts 有「安装后不许导入新脚本」限制 → loader 里
    //     importScripts 库文件在某些 SW 生命周期会被拒
    // 所以最终形态是**直接 inline**：垫片 + 库 bundle 拼进 background.js 末尾（用标记包裹、
    // 可幂等剥离）。等效正式接入时的静态引入。
    // GM_LIB=0：二分实验 —— 摘掉库，回到第 3 步的桩模式。
    const gmLib = process.env.GM_LIB !== '0'
    const bgFile = join(EXTENSION_PATH, 'background.js')
    const bg = readFileSync(bgFile, 'utf8')
    const stripInline = () => {
      const m = bg.match(/;\s*\/\/__gmRuntimeInline BEGIN[\s\S]*\/\/__gmRuntimeInline END\s*\n?/)
      if (m) writeFileSync(bgFile, bg.replace(m[0], ''))
    }
    if (gmLib) {
      stripInline()
      // 垫片：VM 库初始化期对宿主环境的三处假设，不改 VM 源码、在宿主侧满足它们：
      //   ① getManifest 的 options_ui / icons / action.default_icon —— VM safe-globals /
      //      icon.js 初始化期读取；图标文件名必须是 VM 风格「icon<数字>.png」（icon.js 用
      //      /\d+(\w*)\./ 从文件名提取变体后缀，getURL 不校验文件存在）
      //   ② chrome.webNavigation —— VM icon.js 模块顶层挂 onCommitted（badge），需要
      //      webNavigation 权限，本扩展没有 → no-op stub
      //   ③ userScripts.unregister/register —— VM 的 registerInjector 会无参 unregister
      //      注销全部注入件、重注自己的（js 指向扩展根 injected*.js）→ 限制无参 unregister
      //      到 VM 自己的 id、把 VM 注入器的文件路径映射到宿主产物位置（gm-runtime/）
      const shim = [
        ';try {',
        '  const __gmOrig = chrome.runtime.getManifest.bind(chrome.runtime)',
        '  chrome.runtime.getManifest = (...a) => {',
        '    const m = __gmOrig(...a)',
        '    if (!m.options_ui) m.options_ui = { page: "index.html", open_in_tab: false }',
        '    if (!m.icons) m.icons = { 16: "/icon16.png", 32: "/icon32.png", 48: "/icon48.png", 128: "/icon128.png" }',
        '    if (!m.action.default_icon) m.action.default_icon = { 16: "/icon16.png", 32: "/icon32.png" }',
        '    return m',
        '  }',
        '  if (!chrome.webNavigation) {',
        '    const noopEvt = { addListener() {}, removeListener() {}, hasListener: () => false }',
        '    chrome.webNavigation = { onCommitted: noopEvt, onBeforeNavigate: noopEvt, onDOMContentLoaded: noopEvt, onCompleted: noopEvt, onHistoryStateUpdated: noopEvt, onReferenceFragmentUpdated: noopEvt, onTabReplaced: noopEvt }',
        '  }',
        '  const __usUnreg = chrome.userScripts.unregister.bind(chrome.userScripts)',
        '  chrome.userScripts.unregister = (opt) => __usUnreg(opt || { ids: ["1000", "1001"] })',
        '  const __usReg = chrome.userScripts.register.bind(chrome.userScripts)',
        '  chrome.userScripts.register = (scripts) => __usReg(scripts.map((s) => s.id === "1001" ? {',
        '    ...s,',
        '    js: s.js.map((f) => ({ file: f.file.startsWith("injected") ? "gm-runtime/" + f.file : f.file })),',
        '  } : s))',
        '} catch (e) { self.__gmRuntimeError = String((e && e.stack) || e) }',
      ].join('\n')
      const bundle = readFileSync(join(RUNTIME_DIST, SW_LIB, `${SW_LIB}.js`), 'utf8')
      appendFileSync(bgFile, `\n;//__gmRuntimeInline BEGIN\n${shim}\n${bundle}\n;//__gmRuntimeInline END\n`)
    } else {
      stripInline()
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
      { id: API_ID, files: INJECTOR_ENTRIES.map((n) => `${n}.js`) },
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
   * 幂等装配 VM 的真实 background 库（第二批的核心验证，替代第一批的硬编码桩）：
   * 库已在 SW 顶层随 importScripts 加载（见 beforeAll）—— 这里确保初始化完成、注入件注册、
   * listener 挂接。**可重复调用**：SW 被回收重启后，evaluate 挂的 listener 与全局标记都会消失
   * （库经 importScripts 随顶层自动重载），重调本函数即恢复装配 —— 「每次导航前重挂」的语义
   * 与正式接入时「SW 重启后重建注入面」是同一件事。
   * GetInjected 走的是 VM 的完整真链路：tester 匹配 URL → preinject 准备注入描述。
   * 响应信封照 VM 的 browser.js wrapResponse（`[result ?? null, error]`，content 层的
   * unwrapResponse 读 [0]/[1]）。
   */
  async function ensureRuntime(): Promise<void> {
    const mode = process.env.GM_LIB !== '0' ? 'lib' : 'stub'
    await sw!.evaluate(
      async ({ logKey, apiId, injectorFiles, mode }: {
        logKey: string
        apiId: string
        injectorFiles: string[]
        mode: 'lib' | 'stub'
      }) => {
      // 库已随 SW 顶层 importScripts 加载（globalThis.__gmRuntime 由库产物挂上）
      const g = globalThis as unknown as {
        __gmRuntime?: RuntimeMod
        __gmRuntimeError?: string
        __vmRuntimeListenerInstalled?: boolean
      }
      const mod = g.__gmRuntime
      if (mode === 'lib' && !mod) {
        throw new Error(`sw 库未加载：globalThis.__gmRuntime 不存在；装配错误：${g.__gmRuntimeError ?? '（无记录 —— importScripts 可能根本没执行）'}`)
      }
      // 挂接（幂等：标记随 SW 生命周期存亡 —— 重启后标记消失，这里重新走一遍装配）
      if (g.__vmRuntimeListenerInstalled) return
      g.__vmRuntimeListenerInstalled = true
      // 注入件注册（SW 重启后注册可能丢失 —— 装配时确保存在）。
      // 用 VM 官方的注册语义（id '1001' + 扩展根相对文件名 injected*.js）—— 文件路径由垫片
      // 映射到宿主产物位置（gm-runtime/）。这样与 VM 的 registerInjector 完全同一形态。
      await chrome.userScripts.configureWorld({
        messaging: true,
        csp: "script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline' data: blob:",
      })
      await chrome.userScripts.unregister({ ids: [apiId] }).catch(() => {})
      await chrome.userScripts.register([
        {
          id: apiId,
          runAt: 'document_start',
          allFrames: true,
          matches: ['<all_urls>'],
          js: injectorFiles.map((file) => ({ file })),
        },
      ])
      if (mode === 'lib') await mod!.initGM()
      const logHit = (cmd: string) => {
        chrome.storage.session.get(logKey).then((cur) => {
          const log = (cur[logKey] ?? {}) as Record<string, number>
          log[cmd] = (log[cmd] ?? 0) + 1
          chrome.storage.session.set({ [logKey]: log })
        })
      }
      const rt = chrome.runtime as unknown as {
        onUserScriptMessage?: { addListener: (cb: unknown) => void }
      }
      if (mode === 'stub') {
        // 第 3 步绿路径：硬编码 GetInjected 应答（execute 喂数据 + messaging 信封双通道）
        const injection = {
          scripts: [{
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
          }],
          cache: {},
          ids: [1],
          runAt: { 1: 'start' },
          value: {},
          valueIds: [],
          errors: '',
          page: true,
          sessionId: 'gm-runtime-probe',
          info: { ua: {}, gmi: { downloadMode: 'browser', isIncognito: false } },
        }
        rt.onUserScriptMessage?.addListener((msg, sender, sendResponse) => {
          const cmd = (msg as { cmd?: string } | undefined)?.cmd
          if (!cmd) return undefined
          logHit(cmd)
          if (cmd !== 'GetInjected') return undefined
          const senderTabId = (sender as { tab?: { id?: number } } | undefined)?.tab?.id
          if (senderTabId != null) {
            chrome.userScripts.execute({
              js: [{ code: `window['Violentmonkey'](${JSON.stringify(injection)})` }],
              target: { tabId: senderTabId },
              world: 'USER_SCRIPT',
            }).catch(() => {})
          }
          sendResponse([injection, 0])
          return true
        })
      } else {
        // 库模式：GetInjected 走 VM 完整真链路（tester 匹配 → preinject 准备）
        const logErr = (cmd: string, err: string) => {
          chrome.storage.session.get(`${logKey}Err`).then((cur) => {
            const log = (cur[`${logKey}Err`] ?? {}) as Record<string, string>
            log[cmd] = err
            chrome.storage.session.set({ [`${logKey}Err`]: log })
          })
        }
        rt.onUserScriptMessage?.addListener((msg, sender, sendResponse) => {
          const cmd = (msg as { cmd?: string } | undefined)?.cmd
          if (!cmd) return undefined
          logHit(cmd)
          const p = mod!.dispatch(msg as { cmd?: string }, sender)
          if (p instanceof Promise) {
            p.then(
              (res) => {
                // 记录 GetInjected 的返回概要（确认 VM 真链路是否交出了脚本 + 关键字段）
                const r = res as {
                  scripts?: unknown[]
                  injectInto?: string
                  page?: boolean
                } | undefined
                if (cmd === 'GetInjected') {
                  logErr(cmd, 'OK injectInto=' + r?.injectInto
                    + ' page=' + r?.page
                    + ' nscripts=' + (r?.scripts?.length ?? -1))
                }
                try {
                  // ★ JSON round-trip：VM 内部对象是 null-prototype 的 createNullObj 形态，
                  // structured clone 可能失败 → sendResponse 抛错 → 响应丢失 → content 层
                  // 的 sendMessageRetry 疯狂重试（实测 15s 内 947 次）。
                  const plain = JSON.parse(JSON.stringify(res ?? null))
                  // ★ GetInjected 的数据投递走 VM 官方通道（registerScriptDataMV3 同语义）：
                  // execute 把 window.Violentmonkey(data) 喂给 content 层的等待器
                  // （USER_SCRIPT 世界）。实测 onUserScriptMessage 的 sendResponse 在异步
                  // 延迟后会失效（"sendResponse is not a function"）—— messaging 回传只当
                  // 賽跑陪跑，数据以 execute 为准。
                  const senderTabId = (sender as { tab?: { id?: number } } | undefined)?.tab?.id
                  if (cmd === 'GetInjected' && senderTabId != null) {
                    chrome.userScripts.execute({
                      js: [{ code: `window['Violentmonkey'](${JSON.stringify(plain)})` }],
                      target: { tabId: senderTabId },
                      world: 'USER_SCRIPT',
                    }).catch(() => {})
                  }
                  sendResponse([plain, false])
                } catch (e) {
                  logErr(cmd, 'sendResponse 失败: ' + String(e))
                }
              },
              (err) => {
                logErr(cmd, String((err && (err as Error).stack) || err))
                sendResponse([null, [String(err), '']])
              },
            )
            return true
          }
          return undefined
        })
      }
    }, {
      logKey: LOG_KEY,
      apiId: '1001',
      injectorFiles: INJECTOR_ENTRIES.map((n) => `${n}.js`),
      mode,
    })
  }

  /** 把探针脚本种进 VM 的脚本库（一次性；幂等性靠 VM 自己的同名冲突检查）。仅库模式。 */
  async function seedScript(port: number): Promise<string> {
    return sw!.evaluate(async (script: string) => {
      const g = globalThis as unknown as { __gmRuntime?: RuntimeMod }
      const mod = g.__gmRuntime
      if (!mod) return 'NO_LIB'
      return JSON.stringify({
        parseType: typeof mod.parseScript,
        result: await (async () => {
          try {
            return (await mod.parseScript({ code: script })) ?? null
          } catch (e) {
            return { err: String((e && (e as Error).stack) || e) }
          }
        })(),
      })
    }, makeProbeScript(port))
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
    await ensureRuntime()
    if (process.env.GM_LIB !== '0') {
      const seeded = await seedScript(port)
      console.log(`[E2E] parseScript 结果：${seeded}`)
    }

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
    let tick = 0
    while (Date.now() < deadline) {
      log = await readLog()
      if ((log.GetInjected ?? 0) > 0) break
      // SW 若在导航后闲置被回收，evaluate 挂的 listener 会随之消失 —— 周期性补挂（幂等），
      // 顺带采集诊断：listener 是否真的挂着、库是否随 SW 重启存活
      if (++tick % 4 === 0) {
        const diag = await sw!.evaluate(() => {
          const rt = chrome.runtime as unknown as {
            onUserScriptMessage?: { hasListeners?: () => boolean }
            onMessage?: { hasListeners?: () => boolean }
          }
          return {
            hasUsm: rt.onUserScriptMessage?.hasListeners?.() ?? null,
            hasMsg: rt.onMessage?.hasListeners?.() ?? null,
            gm: !!globalThis.__gmRuntime,
          }
        })
        console.log(`[E2E] 诊断#${tick}：${JSON.stringify(diag)}`)
        await ensureRuntime()
      }
      await page.waitForTimeout(500)
    }
    console.log(`[E2E] 桩收到的命令：${JSON.stringify(log)}`)
    const errLog = await sw!.evaluate(
      async (k: string) => (await chrome.storage.session.get(k))[k],
      `${LOG_KEY}Err`,
    )
    console.log(`[E2E] dispatch 错误：${JSON.stringify(errLog) ?? '无'}`)
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
