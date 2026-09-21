// AI 生成脚本的端测（README 手测 #11 的核心链路）。
//
// 手测 #11 原本要：在面板里描述需求 → 看进度流的工具卡（script_spec / script_read / script_apply）
// → 生成卡片出现 → 点「启用并生效」→ 打开目标页确认脚本已生效。这一整条以前只能人肉，因为
// 它要模型**发工具调用**。
//
// 现在 stub 会发 OpenAI 形状的工具调用（见 e2e/model-stub.ts 的 `plan`），于是这条链路可以脚本化：
// 第 1 次请求 → 让它调 `script_spec`；第 2 次（带回 spec 结果）→ 让它调 `script_apply` 并给出源码；
// 第 3 次收尾。断言落在三处：工具声明到了模型、工具结果回流了、**生成的脚本真的落进了项目**。
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extensionIdFromServiceWorker, getServiceWorker, launchExtensionContext, openMessengerPage, sendToSw } from './extension'
import { startModelStub } from './model-stub'

const APP_PAGE = 'floatpanel.html'
/** 生成脚本里埋的标记：从项目库里捞它，证明「AI 给的源码」原样落了盘 */
const MARKER = 'DL_E2E_GENERATED_MARKER'
const GEN_CODE = [
  '// ==UserScript==',
  '// @name         端测生成的小脚本',
  '// @namespace    https://duoling.example',
  '// @match        https://example.com/*',
  '// @grant        none',
  '// ==/UserScript==',
  `console.log('${MARKER}')`,
  '',
].join('\n')

interface ScriptSummary {
  uuid: string
  name: string
}
interface ScriptProject {
  /** 源码搬运副本（保存时刻的源码原文）：字段是 `source.code`，不是顶层 `code` */
  source: { code: string; savedAt: number }
}

test.describe.serial('AI 生成脚本（本地模型 stub 发工具调用）', () => {
  let context: BrowserContext | undefined
  let profileDir = ''
  let stub: Awaited<ReturnType<typeof startModelStub>>
  let extensionId = ''
  let messenger: Page | undefined

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-gen-e2e-'))
    // 第 1 次：调 script_spec（拿规范）；第 2 次：调 script_apply（给出源码）；之后收尾
    stub = await startModelStub({
      plan: (_hit, index) => {
        if (index === 0) return { toolCalls: [{ name: 'script_spec', args: {} }] }
        if (index === 1) {
          return {
            toolCalls: [
              {
                name: 'script_apply',
                args: { summary: '端测生成的小脚本', config: { matches: ['https://example.com/*'] }, code: GEN_CODE },
              },
            ],
          }
        }
        return { text: '已经生成好了' }
      },
    })
    context = await launchExtensionContext(profileDir)
    extensionId = extensionIdFromServiceWorker(await getServiceWorker(context))
    messenger = await openMessengerPage(context, extensionId)

    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/${APP_PAGE}`)
    await page.evaluate(
      async (cfg) => {
        const api = (
          window as unknown as {
            api: { model: { save: (c: unknown) => Promise<{ id: string }>; setActive: (id: string) => Promise<void> } }
          }
        ).api
        const p = await api.model.save(cfg)
        await api.model.setActive(p.id)
      },
      { name: 'stub', baseUrl: stub.stub.baseUrl, apiKey: 'sk-stub', model: 'stub-model' },
    )
    await page.close()
  })

  test.afterAll(async () => {
    const withTimeout = (p: Promise<unknown> | undefined, ms: number) =>
      p ? Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve()
    try { await withTimeout(context?.close(), 30_000) } catch { /* 忽略 */ }
    try {
      stub.server.closeAllConnections()
      await withTimeout(new Promise<void>((r) => stub.server.close(() => r())), 5_000)
    } catch { /* 忽略 */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })

  test('模型发 script_spec → script_apply：源码落进项目，收尾文本上屏', async () => {
    const page = await context!.newPage()
    await page.goto(`chrome-extension://${extensionId}/${APP_PAGE}`)

    const box = page.getByRole('textbox').first()
    await box.fill('帮我做一个 example.com 上的小脚本')
    await box.press('Enter')
    await expect(page.getByText(/已经生成好了/), '多步工具循环收尾后的文本应上屏').toBeVisible({ timeout: 30_000 })

    // ① 工具声明到了模型（app 把 script_* 三件套发给模型）
    const firstHit = stub.stub.hits[0]
    expect(firstHit?.toolNames, '模型应收到 script_spec / script_read / script_apply 的声明').toEqual(
      expect.arrayContaining(['script_spec', 'script_read', 'script_apply']),
    )

    // ② 工具结果回流了（第二次请求里带 role=tool 的消息 ⇒ script_spec 真被执行过）
    const secondHit = stub.stub.hits[1]
    expect(secondHit, '多步循环应产生第二次请求').toBeTruthy()
    expect(
      secondHit?.messages.some((m) => m.role === 'tool'),
      '第二次请求应带上工具结果（说明 script_spec 被真的执行了）',
    ).toBe(true)

    // ③ 生成卡片出现（未启用徽标 + 生效范围），点「启用并生效」后源码落进项目库。
    //    注：`script_apply` 只写任务工作区 + 发快照；脚本由 offscreen 收敛时落盘、卡片随之推送。
    const card = page.locator('[data-testid="generation-card"]')
    await expect(card, '多步循环结束后应出现生成卡片').toBeVisible({ timeout: 30_000 })
    await expect(card, '刚生成时应是「尚未启用」').toContainText('尚未启用')
    await card.getByRole('button', { name: /启用并生效/ }).click()

    await expect
      .poll(
        async () => {
          const list = await sendToSw<ScriptSummary[]>(messenger!, { kind: 'userscript:list' })
          if (!list.ok) return `list 失败：${list.error}`
          if (!list.data.length) return '项目库里一个脚本都没有'
          const seen: string[] = []
          for (const s of list.data) {
            const proj = await sendToSw<ScriptProject>(messenger!, { kind: 'userscript:getProject', uuid: s.uuid })
            if (!proj.ok) {
              seen.push(`${s.name}: getProject 失败 ${proj.error}`)
              continue
            }
            const code = String(proj.data?.source?.code ?? '')
            if (code.includes(MARKER)) return 'found'
            seen.push(`${s.name}: code 前 60 字 ${JSON.stringify(code.slice(0, 60))}`)
          }
          return seen.join(' | ')
        },
        { timeout: 20_000, message: 'AI 生成的脚本应出现在项目库里（含 stub 给的源码）' },
      )
      .toBe('found')

    await page.close()
  })
})
