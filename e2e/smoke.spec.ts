// 端测冒烟。
// 覆盖四条面：workbench 页 / SW 命令面 + offscreen 就绪 / 用户脚本注入（GM 桥）/ 网页浮层页。
// 浮层的真实注入链路（content script 挂 iframe）由手测覆盖 —— 无头下没有 FAB 点击这条路径。
import { test, expect, type BrowserContext, type Page, type Worker } from '@playwright/test'
import * as http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  enableDevMode,
  enableUserScripts,
  extensionIdFromServiceWorker,
  getServiceWorker,
  launchExtensionContext,
  openMessengerPage,
  sendToSw,
  type UserScriptsBootstrap,
} from './extension'

test.describe.serial('哆灵扩展端测冒烟', () => {
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
    // 工作台那几个调试入口默认不显示（开发者模式关闭），端测要验它们就得先开总闸
    await enableDevMode(messenger)
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

  test('workbench「AI 工具」标签页：契约渲染 + 轨迹空态', async () => {
    const page = await context!.newPage()
    await page.goto(`chrome-extension://${extensionId}/workbench.html`)

    // 左侧导航进入：面板挂载，左栏 6 个工具全部来自静态目录（与运行时同源，见单测防漂移）
    await page.locator('button[aria-label="AI 工具"]').click()
    await expect(page.locator('[data-testid="agent-tools-panel"]')).toBeVisible()
    for (const name of ['script_spec', 'script_read', 'script_apply', 'element_read', 'page_snapshot', 'error_read']) {
      await expect(page.locator(`[data-testid="agent-tools-select-${name}"]`)).toBeVisible()
    }

    // 选中写工具：契约区默认**收起**（入参表有 10 项，展开会把下方轨迹顶出屏幕）→ 点标题展开
    await page.locator('[data-testid="agent-tools-select-script_apply"]').click()
    const contract = page.locator('[data-testid="agent-tools-contract"]')
    await expect(contract).toContainText('契约详情')
    await page.locator('[data-testid="agent-tools-contract-toggle"]').click()
    await expect(contract).toContainText('updateUuid')
    await expect(contract).toContainText('必填')
    await expect(page.getByText('单任务最多 8 步')).toBeVisible()

    // 没跑过对话 → 无任何工具调用痕迹：一条轨迹行都不该有，且给空态文案而不是留白
    // （空态文案分「暂无会话记录」与「还没有这条工具的调用记录」两支，此处不锁死哪一支）
    await expect(page.locator('[data-testid^="agent-tools-trace-"]')).toHaveCount(0)
    await expect(page.getByText(/暂无会话记录|还没有这条工具的调用记录/)).toBeVisible()
    await page.close()
  })

  test('workbench「GM API」标签页：清单渲染 + 详情展开 + 搜索空态', async () => {
    const page = await context!.newPage()
    await page.goto(`chrome-extension://${extensionId}/workbench.html`)

    // 左侧导航进入：面板挂载，脚本世界 GM 的能力清单来自静态目录（与注入真身同源，见单测防漂移）
    await page.locator('button[aria-label="GM API"]').click()
    await expect(page.locator('[data-testid="gm-api-panel"]')).toBeVisible()
    for (const path of ['GM_getValue', 'GM_xmlhttpRequest', 'GM_cookie.set', 'GM.page.fetchHook']) {
      await expect(page.locator(`[data-testid="gm-api-card-${path}"]`)).toBeVisible()
    }

    // 详情默认收起（50+ 条全铺开没法扫）→ 点标题行才出签名
    const card = page.locator('[data-testid="gm-api-card-GM_getValue"]')
    await expect(card).not.toContainText('GM_getValue(key, defaultValue?)')
    await page.locator('[data-testid="gm-api-card-toggle-GM_getValue"]').click()
    await expect(card).toContainText('GM_getValue(key, defaultValue?)')

    // 搜不到的关键词：空态文案而不是留白
    await page.locator('[data-testid="gm-api-search"]').fill('zzz-not-exist')
    await expect(page.locator('[data-testid="gm-api-empty"]')).toBeVisible()
    await page.close()
  })

  // ———————————————————————————— 网页浮层 ————————————————————————————

  test('floatpanel.html 页面可加载（浮层对话页）', async () => {
    const page = await context!.newPage()
    await page.goto(`chrome-extension://${extensionId}/floatpanel.html`)
    await expect(page).toHaveTitle('哆灵')
    await expect(page.locator('#app')).toBeVisible()
    await page.close()
  })

  // ———————————————————————————— 用户脚本注入 ————————————————————————————

  test('用户脚本注入探针页：脚本执行 + GM 桥往返', async () => {
    test.skip(!userScriptsAvailable, 'chrome.userScripts 在无头 Chromium 下不可用（引导失败），注入面转手测')

    // 1. 创建脚本：offscreen 侧自动命名 + 初始模板（单文件 script.js）+ 状态库落盘 + git 快照，SW 注册
    const created = await sendToSw<{ uuid: string; name: string; registerError?: string }>(messenger!, {
      kind: 'userscript:create',
    })
    expect(created.ok, `userscript:create 失败：${created.ok ? '' : created.error}`).toBe(true)
    if (!created.ok) return
    expect(created.data.registerError, '注册不应报错').toBeUndefined()
    const { uuid } = created.data

    // 2. 探针脚本：验证 GM_info 已挂 + GM.* 经桥（SW duoling-usdata 库）往返。
    //    这里刻意走异步形态 GM.getValue：同步 GM_getValue 读的是注入时的本地快照，
    //    读回自己刚写的值**证明不了**桥通——异步形态每次回后台读，才真验到桥。
    const probeCode = `
;(async () => {
  var mark = function (t) {
    var el = document.getElementById('${PROBE_MARKER_ID}')
    if (!el) { el = document.createElement('div'); el.id = '${PROBE_MARKER_ID}'; (document.body || document.documentElement).appendChild(el) }
    el.textContent = t
  }
  try {
    if (!window.GM_info) return mark('GM_MISSING')
    await GM.setValue('e2e-ok', 'yes')
    var v = await GM.getValue('e2e-ok')
    mark(v === 'yes' ? 'GM_OK' : 'GM_BAD_VALUE:' + String(v))
  } catch (e) { mark('GM_FAIL:' + ((e && e.message) || e)) }
})()
`
    // 单文件保存语义：保存恒成功、保存即注入——offscreen 写 duoling-fs + git 提交 + 状态库落盘，
    // SW 直读源码副本重注册，不再有构建环节（探针代码原样注入）
    const updated = await sendToSw<{ registerError?: string; warnings?: string[] }>(messenger!, {
      kind: 'userscript:save',
      uuid,
      code: probeCode,
    })
    expect(updated.ok, `userscript:save 失败：${updated.ok ? '' : updated.error}`).toBe(true)
    if (updated.ok) {
      expect(updated.data.registerError, '重注册不应报错').toBeUndefined()
    }

    // 3. 打开探针页，等脚本标记结果（runAt document_end）
    const page = await context!.newPage()
    await page.goto(`http://127.0.0.1:${probePort}/probe.html`)
    await expect(page.locator(`#${PROBE_MARKER_ID}`)).toHaveText('GM_OK', { timeout: 20_000 })
    await page.close()

    // 4. 清理：删除探针脚本（注销 + 状态库 + git 仓 + GM 值）
    const removed = await sendToSw<void>(messenger!, { kind: 'userscript:remove', uuid })
    expect(removed.ok, `userscript:remove 失败：${removed.ok ? '' : removed.error}`).toBe(true)
  })

  // —————————————————————— 删除脚本的连带清理 ——————————————————————

  test('删除脚本连带清掉它的报错记录（运行日志不留已删脚本的孤儿行）', async () => {
    test.skip(!userScriptsAvailable, 'chrome.userScripts 在无头 Chromium 下不可用（引导失败），转手测')

    /** 运行日志时间线里当前出现过的脚本 uuid（运行行取 uuid，错误行取 record.uuid；
     *  经 SW 读命令；信封异常时回空数组，由断言兜底） */
    const errorUuids = async (): Promise<string[]> => {
      const res = await sendToSw<Array<{ kind: string; uuid?: string; record?: { uuid: string | null } }>>(
        messenger!,
        { kind: 'userscript:runlog' },
      )
      if (!res.ok) return []
      return res.data
        .map((r) => (r.kind === 'run' ? r.uuid : (r.record?.uuid ?? null)))
        .filter((u): u is string => u !== null)
    }
    expect((await sendToSw<unknown[]>(messenger!, { kind: 'userscript:runlog' })).ok, 'userscript:runlog 应可读').toBe(true)

    // 1. 建脚本（create 默认 enabled）
    const created = await sendToSw<{ uuid: string; name: string }>(messenger!, { kind: 'userscript:create' })
    expect(created.ok, `userscript:create 失败：${created.ok ? '' : created.error}`).toBe(true)
    if (!created.ok) return
    const { uuid } = created.data

    // 2. 塞一条非法 match pattern：这是**脚本自身缺陷**，注册当场失败 → 应写一条该脚本的 register 记录。
    //    确定性造错（不必开页面等运行期错误），同时也验证了 register 阶段的记录同样随删除清理。
    //    单文件保存语义下 config 由 save 一并传入，源码恒可保存（此处源码本身合法），失败发生在注册阶段。
    const bad = await sendToSw<{ registerError?: string }>(messenger!, {
      kind: 'userscript:save',
      uuid,
      code: "console.log('e2e')",
      config: { matches: ['not-a-match-pattern'], allFrames: true, runAt: 'document_end' },
    })
    expect(bad.ok, `userscript:save 失败：${bad.ok ? '' : bad.error}`).toBe(true)
    if (bad.ok) expect(bad.data.registerError, '非法 matches 应触发注册失败').toBeTruthy()

    // 注册失败写记录是 fire-and-forget（后台不 await），故轮询等它落盘
    await expect.poll(errorUuids, { timeout: 15_000 }).toContain(uuid)

    // 3. 删除脚本：它的报错记录必须一并消失，否则运行日志留下一个已删脚本的孤儿行
    const removed = await sendToSw<void>(messenger!, { kind: 'userscript:remove', uuid })
    expect(removed.ok, `userscript:remove 失败：${removed.ok ? '' : removed.error}`).toBe(true)
    expect(await errorUuids(), '运行日志不该留下已删脚本的记录').not.toContain(uuid)
  })
})
