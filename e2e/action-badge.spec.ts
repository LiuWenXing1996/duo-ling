// 工具栏角标的端测：**数字 = 这个标签页在跑几个脚本**（与浮层灵动岛、popup 的「页面脚本」区同源，
// 见 src/lib/userscripts/page-monitor.ts 的运行登记表）。
//
// 这里不造假信号：脚本经命令面存进库、由 `chrome.userScripts` 真注入探针页，runstart 是真的从 GM
// 包装广播出来的 —— 整条链路（注入 → 登记 → 重算 → `chrome.action`）都在被测范围内。伪造一条
// runstart 只能证明「重算函数会跑」，证明不了「页面里跑着的脚本会不会被数上」。
//
// 引导姿势与 gm-matrix.spec.ts 共用：Phase A 程序化开 userScripts 开关 → 同 profile 重启 →
// `chrome.userScripts` 由 undefined 变可用（开关状态随 profile 持久化）。
//
// 覆盖：命中即亮 + 悬停文案与灵动岛同句；**按标签页各算各的**（一个页命中两个脚本、另一页只命中
// 一个，且互不串页）；换文档后重新登记；禁用脚本后重载不再算它；扩展自己的页面不在任何脚本的
// 注入面内 → 不亮，也不留全局兜底值。另有一组前提**相反**的用例（不引导）：引擎未授权 → 全局红点。
import { test, expect, type BrowserContext, type Page, type Worker } from '@playwright/test'
import * as http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkUserScriptsAvailable,
  enableUserScripts,
  extensionIdFromServiceWorker,
  getServiceWorker,
  launchExtensionContext,
  openMessengerPage,
  sendToSw,
} from './extension'

/**
 * 探针脚本：只做一件事 —— 在 `documentElement` 上留个记号。
 * 先断言「真注入了」再断言角标，失败时才能分清是注入没成还是角标没报。
 */
function probeScript(name: string, match: string, mark: string): string {
  return [
    '// ==UserScript==',
    `// @name ${name}`,
    '// @namespace duoling.e2e',
    '// @version 1.0.0',
    `// @match ${match}`,
    '// @grant none',
    '// ==/UserScript==',
    `document.documentElement.setAttribute('${mark}', '1')`,
    '',
  ].join('\n')
}

/** 命中所有 http(s) 页面 */
const SCRIPT_ALL = probeScript('e2e 全域脚本', '*://*/*', 'data-e2e-all')
/** 只命中探针页的 `/a` 路径 —— 用来验「不命中的脚本不进那一页的数」 */
const SCRIPT_A = probeScript('e2e 仅 A 页脚本', 'http://127.0.0.1/a*', 'data-e2e-a')

test.describe.serial('工具栏角标（按标签页报脚本运行数）', () => {
  let context: BrowserContext | undefined
  let sw: Worker
  let messenger: Page
  let profileDir = ''
  let server: http.Server | undefined
  let baseUrl = ''
  let available = false

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-badge-e2e-'))

    // Phase A：程序化打开 userScripts 开关（随 profile 持久化）
    const bootstrapCtx = await launchExtensionContext(profileDir)
    const bootstrapSw = await getServiceWorker(bootstrapCtx)
    await enableUserScripts(bootstrapCtx, extensionIdFromServiceWorker(bootstrapSw))
    await bootstrapCtx.close()

    // Phase B：同 profile 重启，开关生效
    context = await launchExtensionContext(profileDir)
    sw = await getServiceWorker(context)
    messenger = await openMessengerPage(context, extensionIdFromServiceWorker(sw))
    available = await checkUserScriptsAvailable(sw)
    if (!available) return // 后面的 test.skip 兜住

    // 存成脚本：新建即启用，`userscript:save` 落库后立即重注册（保存即注入）
    for (const code of [SCRIPT_ALL, SCRIPT_A]) {
      const created = await sendToSw<{ uuid: string }>(messenger, { kind: 'userscript:create' })
      expect(created.ok, 'userscript:create 应成功').toBe(true)
      if (!created.ok) return
      const saved = await sendToSw<{ warnings?: string[]; registerError?: string }>(messenger, {
        kind: 'userscript:save',
        uuid: created.data.uuid,
        code,
      })
      expect(saved.ok, 'userscript:save 应成功').toBe(true)
      if (saved.ok) expect(saved.data.registerError, '注册不应报错').toBeUndefined()
    }

    // 探针页：`/a` 与 `/b` 两条路径（第二个脚本只命中 `/a`，用它造出「两页数不同」）
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><body><h1>${req.url ?? '/'}</h1></body></html>`)
    })
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port))
    })
    baseUrl = `http://127.0.0.1:${port}`
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

  /** 某个标签页的角标文字（空串 = 没亮）。角标按标签页各设各的，故必须指明是哪一页 */
  const badge = (tabId: number): Promise<string> =>
    sw.evaluate(async (id) => await chrome.action.getBadgeText({ tabId: id }), tabId)

  /** 某个标签页的图标悬停文案（空串 = 已恢复默认） */
  const title = (tabId: number): Promise<string> =>
    sw.evaluate(async (id) => await chrome.action.getTitle({ tabId: id }), tabId)

  /** 全局兜底值：引擎可用时角标一律按标签页设，它必须恒为空（留着的话每个标签页都会带上它） */
  const globalBadge = (): Promise<string> => sw.evaluate(async () => await chrome.action.getBadgeText({}))

  /** 该地址当前开着的标签页 id（本 spec 每个地址只开一页） */
  async function tabIdOf(url: string): Promise<number> {
    const ids = await sw.evaluate(
      async (u) => (await chrome.tabs.query({})).filter((t) => t.url === u).map((t) => t.id ?? -1),
      url,
    )
    expect(ids[0], `${url} 的 tabId 应能反查到`).toBeGreaterThan(0)
    return ids[0]!
  }

  /** 等探针页上出现记号（= 脚本真的注入并执行了） */
  async function expectMarks(page: Page, marks: string[]): Promise<void> {
    await expect
      .poll(
        async () =>
          await page.evaluate(
            (names) => names.map((n) => document.documentElement.getAttribute(n)),
            marks,
          ),
        { timeout: 20_000, message: '探针脚本没注入（记号没出现）' },
      )
      .toEqual(marks.map(() => '1'))
  }

  test('注入即亮：数字 = 该页命中脚本数，悬停文案与灵动岛同句', async () => {
    test.skip(!available, 'chrome.userScripts 引导失败，角标链路转手测')
    const page = await context!.newPage()
    await page.goto(`${baseUrl}/a`)
    await expectMarks(page, ['data-e2e-all', 'data-e2e-a'])
    const tabId = await tabIdOf(`${baseUrl}/a`)

    await expect.poll(() => badge(tabId), { message: '两个脚本在跑' }).toBe('2')
    expect(await title(tabId), '悬停文案与灵动岛同一句').toBe('2 个脚本在运行')

    await page.close()
  })

  test('按标签页各算各的：不命中的脚本不进那一页的数，也不串页', async () => {
    test.skip(!available, 'chrome.userScripts 引导失败，角标链路转手测')
    const pageA = await context!.newPage()
    await pageA.goto(`${baseUrl}/a`)
    await expectMarks(pageA, ['data-e2e-all', 'data-e2e-a'])
    const pageB = await context!.newPage()
    await pageB.goto(`${baseUrl}/b`)
    await expectMarks(pageB, ['data-e2e-all'])
    const [aId, bId] = [await tabIdOf(`${baseUrl}/a`), await tabIdOf(`${baseUrl}/b`)]
    expect(bId, '两个地址该落在两个标签页上').not.toBe(aId)

    // 「仅 A 页」那个脚本没命中 B → B 只数全域那一个
    await expect.poll(() => badge(aId), { message: 'A 页命中两个' }).toBe('2')
    await expect.poll(() => badge(bId), { message: 'B 页只命中一个' }).toBe('1')
    expect(await title(bId)).toBe('1 个脚本在运行')
    expect(await badge(aId), 'B 页开了不影响 A 页的数').toBe('2')

    // 关掉 B：A 页照旧，且不留全局兜底值（下一个新页不该自动带上数字）
    await pageB.close()
    await expect.poll(() => badge(aId)).toBe('2')
    expect(await globalBadge()).toBe('')

    await pageA.close()
  })

  test('换文档后重新登记；禁用脚本后重载不再算它', async () => {
    test.skip(!available, 'chrome.userScripts 引导失败，角标链路转手测')
    const page = await context!.newPage()
    await page.goto(`${baseUrl}/a`)
    await expectMarks(page, ['data-e2e-all', 'data-e2e-a'])
    const tabId = await tabIdOf(`${baseUrl}/a`)
    await expect.poll(() => badge(tabId)).toBe('2')

    // 重载 = 换文档：登记表先清零，再由新文档的 runstart 填回来 —— 最终仍是 2
    await page.reload()
    await expectMarks(page, ['data-e2e-all', 'data-e2e-a'])
    await expect.poll(() => badge(tabId), { message: '新文档要重新登记' }).toBe('2')

    // 禁用「仅 A 页」那个脚本 → 重载后只剩全域那一个
    const list = await sendToSw<Array<{ uuid: string; name: string }>>(messenger, {
      kind: 'userscript:list',
    })
    expect(list.ok, 'userscript:list 应成功').toBe(true)
    if (!list.ok) return
    const target = list.data.find((s) => s.name === 'e2e 仅 A 页脚本')
    expect(target, '该脚本应在列表里').toBeTruthy()
    await sendToSw(messenger, { kind: 'userscript:toggle', uuid: target!.uuid, enabled: false })

    await page.reload()
    await expectMarks(page, ['data-e2e-all'])
    await expect.poll(() => badge(tabId), { message: '禁用的脚本不该再算上' }).toBe('1')

    await page.close()
  })

  test('扩展自己的页面不在注入面内 → 不亮，也不留全局兜底值', async () => {
    test.skip(!available, 'chrome.userScripts 引导失败，角标链路转手测')
    // popup 页（chrome-extension://）不在任何脚本的 matches 里
    const msgTabId = await tabIdOf(messenger.url())
    expect(await badge(msgTabId), '扩展自己的页面没有脚本在跑').toBe('')
    expect(await title(msgTabId)).toBe('')
    expect(await globalBadge()).toBe('')
  })
})

// —— 引擎未授权：全局红点 ——
//
// 与上面那组**前提相反**：这里刻意不跑 Phase A 引导，让 `chrome.userScripts` 保持不存在 —— 这正是
// 新装扩展的真实状态（Chrome ≥138 的「允许运行用户脚本」按扩展默认关着）。此时没有任何脚本注册得
// 进去，「哪个页面在跑几个脚本」无从谈起，角标该是一枚**全局**红点：它说的是「这个扩展现在用不了
// 用户脚本」，与具体标签页无关，因此不带 tabId、也不需要给谁设专属值。
//
// 若本环境的 Chrome 一上来就允许 userScripts（版本或启动参数差异），未授权态造不出来 —— 本组自动跳过。
test.describe.serial('工具栏角标（引擎未授权 → 全局红点）', () => {
  let context: BrowserContext | undefined
  let sw: Worker
  let profileDir = ''
  let available = true

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-badge-dot-e2e-'))
    context = await launchExtensionContext(profileDir)
    sw = await getServiceWorker(context)
    available = await checkUserScriptsAvailable(sw)
  })

  test.afterAll(async () => {
    const withTimeout = (p: Promise<unknown> | undefined, ms: number) =>
      p ? Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve()
    try { await withTimeout(context?.close(), 30_000) } catch { /* 忽略 */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })

  test('开关没开 → 全局红点：不带 tabId，也不报任何数字', async () => {
    test.skip(available, '本环境 userScripts 默认可用，造不出未授权态')
    await openMessengerPage(context!, extensionIdFromServiceWorker(sw))

    // SW 冷启动那条重算（clearAllBadges → refreshBadge）落地后才有值，故轮询等它出现；
    // 文案与字符同一轮设下去，一起断言省得两次等待各写一遍
    await expect
      .poll(
        async () =>
          await sw.evaluate(async () => ({
            text: await chrome.action.getBadgeText({}),
            title: await chrome.action.getTitle({}),
          })),
        { message: '引擎未授权该亮红点' },
      )
      .toEqual({ text: '待授权', title: '用户脚本未授权，工作台「引导」有开启步骤' })

    // 「不分 tab」那层：红点设在**全局**、没有给任何标签页设专属值 —— 所以从标签页维度读回来不该是
    // 数字（未授权时压根不存在「这一页在跑几个脚本」这回事）
    const tabId = await sw.evaluate(
      async () => ((await chrome.tabs.query({})).find((t) => t.id != null)?.id ?? -1),
    )
    expect(tabId, '应至少有一个标签页可读').toBeGreaterThan(0)
    expect(
      await sw.evaluate(async (id) => await chrome.action.getBadgeText({ tabId: id }), tabId),
      '没有哪一页被设上专属数字',
    ).not.toMatch(/^\d+$/)
  })
})
