// 对话附件的端测：把「选文件 → 压缩 → 发出去 → 落到模型请求里」这条链路在无头环境跑通。
//
// 为什么必须端测（组件测试验不到）：
//   · 图片压缩走 `createImageBitmap` + canvas，happy-dom 里没有这两个 —— 组件测试只能验
//     「图片被放行 / 被拦下」，验不了真的压出可用的 data URL；
//   · 「file part 会不会被转成模型认的 image_url」取决于 AI SDK 的 convertToModelMessages，
//     那是跨层行为，只有让请求真的打到桩上才看得见（桩里能读到原始请求体）。
// 真模型不会出现在 CI 里（没有 key、也不该为此花钱），所以用 `e2e/model-stub.ts` 顶替。
import { test, expect, type BrowserContext } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extensionIdFromServiceWorker, getServiceWorker, launchExtensionContext } from './extension'
import { startModelStub, type ModelStubHit } from './model-stub'

const APP_PAGE = 'floatpanel.html'

/**
 * 生成一份**真能被解码**的 PNG 素材（2×2 纯色）。
 * 不要用硬编码的 base64 —— 手写的 1×1 PNG 片段看着像回事，浏览器一解就报
 * `InvalidStateError: The source image could not be decoded`，而失败点会落在压缩逻辑上，
 * 看起来像实现坏了。素材由同一个浏览器现产现用，编码差异不存在。
 */
async function makePngBuffer(page: Awaited<ReturnType<BrowserContext['newPage']>>): Promise<Buffer> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(0, 0, 2, 2)
    return canvas.toDataURL('image/png').split(',')[1] ?? ''
  })
  return Buffer.from(base64, 'base64')
}

/** 最后一次请求里最后一条 user 消息（附件就在它身上） */
function lastUserMessage(hit: ModelStubHit | undefined): { content?: unknown } {
  const messages = hit?.messages ?? []
  return ([...messages].reverse().find((m) => m.role === 'user') ?? {}) as { content?: unknown }
}

test.describe.serial('对话附件（本地模型 stub）', () => {
  let context: BrowserContext | undefined
  let profileDir = ''
  let stub: Awaited<ReturnType<typeof startModelStub>>

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-attach-e2e-'))
    stub = await startModelStub()
    context = await launchExtensionContext(profileDir)
    await getServiceWorker(context)
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

  /** 存一份模型配置并激活（设置页保存模型走的就是这两个 API） */
  async function configureModel(page: Awaited<ReturnType<BrowserContext['newPage']>>, vision: boolean): Promise<void> {
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
      { name: 'stub', baseUrl: stub.stub.baseUrl, apiKey: 'sk-stub', model: 'stub-model', vision },
    )
  }

  test('图片：选图 → 压缩成 jpeg data URL → 以 image_url 进模型请求，并在气泡里回显', async () => {
    const id = extensionIdFromServiceWorker(await getServiceWorker(context!))
    const page = await context!.newPage()
    await page.goto(`chrome-extension://${id}/${APP_PAGE}`)
    await configureModel(page, true)

    // 附件入口随能力声明启用（vision: true 时说明里可以发图片）
    const entry = page.locator('[data-testid="add-attachment-button"]')
    await expect(entry).toHaveAttribute('aria-label', '添加图片或文件')

    // 真人路径里用户点按钮选文件；这里直接把文件塞进那个隐藏 input
    await page.setInputFiles('input[type="file"]', {
      name: 'shot.png',
      mimeType: 'image/png',
      buffer: await makePngBuffer(page),
    })
    await expect(page.locator('[data-testid="attachment-chips"]'), '选中后应出现附件 chip').toContainText('shot.png')

    const box = page.getByRole('textbox').first()
    await box.fill('看看这张图')
    await box.press('Enter')

    await expect(page.getByText(/stub 回复：/), '整条链路应跑完').toBeVisible({ timeout: 25_000 })

    // ① 图片确实到了模型请求里，且是**压缩重编码后**的 jpeg（原始是 png —— 这条同时证明了压缩真的跑了）
    const streamed = stub.stub.hits.filter((h) => h.stream)
    const sent = JSON.stringify(lastUserMessage(streamed[streamed.length - 1]).content)
    expect(sent, '图片要以 image_url 形态进请求').toContain('image_url')
    expect(sent, '压缩统一输出 jpeg，所以不会是原始 png').toContain('data:image/jpeg')

    // ② 落盘回显：气泡里能看到缩略图（data URL 随 parts 存进了会话库）
    const thumb = page.locator('[data-testid="message-images"] img')
    await expect(thumb).toHaveCount(1)
    await expect(thumb).toHaveAttribute('src', /^data:image\/jpeg/)
    await page.close()
  })

  test('文本文件：内容拼进正文（带文件名围栏）随消息发出', async () => {
    const id = extensionIdFromServiceWorker(await getServiceWorker(context!))
    const page = await context!.newPage()
    await page.goto(`chrome-extension://${id}/${APP_PAGE}`)
    await configureModel(page, false)

    // 模型不支持图片：入口仍在，但说明改成只能加文本文件（不隐藏入口）
    const entry = page.locator('[data-testid="add-attachment-button"]')
    await expect(entry).toHaveAttribute('aria-label', '添加文本文件（当前模型不支持图片）')

    await page.setInputFiles('input[type="file"]', {
      name: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('这条来自附件', 'utf8'),
    })
    const box = page.getByRole('textbox').first()
    await box.fill('读一下附件')
    await box.press('Enter')

    await expect(page.getByText(/stub 回复：/)).toBeVisible({ timeout: 25_000 })

    const streamed = stub.stub.hits.filter((h) => h.stream)
    const text = JSON.stringify(lastUserMessage(streamed[streamed.length - 1]).content)
    expect(text).toContain('读一下附件')
    expect(text, '文本附件以带文件名的围栏进正文').toContain('【附件：notes.md】')
    expect(text).toContain('这条来自附件')
    // 纯文本模型上不该混进图片
    expect(text).not.toContain('image_url')
    await page.close()
  })

  test('纯图提问：不写字也能发出去（消息正文允许为空）', async () => {
    const id = extensionIdFromServiceWorker(await getServiceWorker(context!))
    const page = await context!.newPage()
    await page.goto(`chrome-extension://${id}/${APP_PAGE}`)
    await configureModel(page, true)

    await page.setInputFiles('input[type="file"]', {
      name: 'only-image.png',
      mimeType: 'image/png',
      buffer: await makePngBuffer(page),
    })
    // 不填任何文字，直接回车 —— 系统提示里的「用户需求」会空着，offscreen 侧有占位兜底
    await page.getByRole('textbox').first().press('Enter')

    await expect(page.getByText(/stub 回复：/), '纯图消息应照常跑完（链路不要求正文非空）').toBeVisible({
      timeout: 25_000,
    })
    const streamed = stub.stub.hits.filter((h) => h.stream)
    const content = JSON.stringify(lastUserMessage(streamed[streamed.length - 1]).content)
    expect(content, '没有文字也要把图片发出去').toContain('image_url')
    await page.close()
  })
})
