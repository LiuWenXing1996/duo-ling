// 对话附件的端测：把「选文件 → 压缩 → 落资源库 → 发出去 → 落到模型请求里」这条链路在无头环境跑通。
//
// 本 spec 守的核心不变式只有一条：**图片字节永不进模型请求**。
//   消息里挂的是一份 `data-asset` 引用（id + 文件名 + MIME + 大小，见 @duoling/shared 的 chat-assets.ts），
//   字节躺在 duoling-fs 的 `/assets/<内容hash>/`（见 @duoling/offscreen-document 的 fs/assets）；
//   送模型前引用被换成一行文字（assetPlaceholderText），模型要看图只能调 image_ask。
//   所以「请求体里出现 image_url / data:image」= 架构被改坏了，这里必须炸。
//
// 为什么必须端测（组件测试验不到）：
//   · 图片压缩走 `createImageBitmap` + canvas，happy-dom 里没有这两个 —— 组件测试只能验
//     「图片被放行 / 被拦下」，验不了真的压出可用的 data URL；
//   · 「引用在送模型那一刻被换成什么」跨了面板 → offscreen → AI SDK 三层，
//     只有让请求真的打到桩上才看得见（桩里能读到原始请求体）；
//   · 落库与读回跨越 offscreen 的 lightning-fs，只有整条扩展跑起来才成立。
// 真模型不会出现在 CI 里（没有 key、也不该为此花钱），所以用 `scripts/model-stub.mts` 顶替。
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extensionIdFromServiceWorker, getServiceWorker, launchExtensionContext } from './extension'
import { saveStubModel } from './model-config'
import { startModelStub, type ModelStubHit } from '../scripts/model-stub.mts'

const APP_PAGE = 'floatpanel.html'

/**
 * 生成一份**真能被解码**的 PNG 素材（纯色）。
 * 不要用硬编码的 base64 —— 手写的 1×1 PNG 片段看着像回事，浏览器一解就报
 * `InvalidStateError: The source image could not be decoded`，而失败点会落在压缩逻辑上，
 * 看起来像实现坏了。素材由同一个浏览器现产现用，编码差异不存在。
 */
async function makePngBuffer(page: Page, width = 2, height = 2): Promise<Buffer> {
  const base64 = await page.evaluate(([w, h]) => {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(0, 0, w, h)
    return canvas.toDataURL('image/png').split(',')[1] ?? ''
  }, [width, height] as const)
  return Buffer.from(base64, 'base64')
}

/**
 * 真实粘贴路径（Ctrl+V）：走 textarea 的 paste 事件。
 * 为什么不用 setInputFiles：那是直塞隐藏 input，绕过了粘贴这条分支（附件类型校验
 * 就走在这条分支上）。
 */
async function pasteImage(page: Page, png: Buffer, name = 'pasted.png'): Promise<void> {
  await page.evaluate(
    ({ name: fileName, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], fileName, { type: 'image/png' }))
      document
        .querySelector('textarea')
        ?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    },
    { name, base64: png.toString('base64') },
  )
}

/** 真实拖拽路径：走 form 的 drop 事件（组件把 drop 挂在表单节点上） */
async function dropImage(page: Page, png: Buffer, name = 'dropped.png'): Promise<void> {
  await page.evaluate(
    ({ name: fileName, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], fileName, { type: 'image/png' }))
      document
        .querySelector('textarea')
        ?.closest('form')
        ?.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    },
    { name, base64: png.toString('base64') },
  )
}

/** 最后一次请求里最后一条 user 消息（附件就在它身上） */
function lastUserMessage(hit: ModelStubHit | undefined): { content?: unknown } {
  const messages = hit?.messages ?? []
  return ([...messages].reverse().find((m) => m.role === 'user') ?? {}) as { content?: unknown }
}

/** 把 stub 收到的 content 拍平成一段文字（可能已是纯串，也可能是 part 数组） */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  const parts = Array.isArray(content) ? content : []
  return parts.map((p) => (p as { text?: string })?.text ?? '').join('\n')
}

/** 最后一条 user 消息送给模型的文字 */
function lastUserText(): string {
  const streamed = stub.stub.hits.filter((h) => h.stream)
  return contentText(lastUserMessage(streamed[streamed.length - 1]).content)
}

/** 断言请求体里没有任何图片字节的痕迹 —— 本 spec 的核心不变式 */
function expectNoImageBytes(text: string): void {
  expect(text, '图片不该以 image_url 形态发给模型').not.toContain('image_url')
  expect(text, '图片字节不该出现在请求体里').not.toContain('data:image')
  expect(text, '连 base64 的痕迹都不该有').not.toContain(';base64,')
}

/** 断言引用被换成了那一行文字（模型据此知道「有图，且要看图得调 image_ask」） */
function expectAssetPlaceholder(text: string, filename: string): void {
  expect(text, '引用应换成一行文字，而不是消失').toContain(`【图片 #`)
  expect(text, `引用里应带上文件名（${filename}）`).toContain(`：${filename}`)
  expect(text, '必须把取图的路告诉模型').toContain('image_ask')
  expect(text, 'assetId 必须是完整的 64 位内容 hash').toMatch(/【图片 #[0-9a-f]{64}：/)
}

/** 气泡里的缩略图（字节是面板按引用现取回来的，不是消息里带的） */
function thumbnail(page: Page) {
  return page.locator('[data-testid="message-images"] img')
}

/** 等缩略图 hydrate 完成并取出它的 data URL */
async function thumbDataUrl(page: Page): Promise<string> {
  await expect(thumbnail(page), '气泡里应出现缩略图').toHaveCount(1)
  await expect(thumbnail(page), '缩略图应由资源库取回（重编码统一 jpeg）').toHaveAttribute(
    'src',
    /^data:image\/jpeg/,
  )
  return (await thumbnail(page).getAttribute('src')) ?? ''
}

let stub: Awaited<ReturnType<typeof startModelStub>>

test.describe.serial('对话附件（本地模型 stub）', () => {
  let context: BrowserContext | undefined
  let profileDir = ''

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-attach-e2e-'))
    stub = await startModelStub()
    context = await launchExtensionContext(profileDir)
    const id = extensionIdFromServiceWorker(await getServiceWorker(context))
    // 模型只能在设置页配（浮层没有设置入口）。工作台与浮层同源共享存储，后面新开的面板直接可用。
    const setup = await context.newPage()
    await setup.goto(`chrome-extension://${id}/workbench.html`)
    await saveStubModel(setup, { baseUrl: stub.stub.baseUrl })
    await setup.close()
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

  /** 开一个浮层页（模型已在 beforeAll 配好，同源共享） */
  async function openPanel(): Promise<Page> {
    const id = extensionIdFromServiceWorker(await getServiceWorker(context!))
    const page = await context!.newPage()
    await page.goto(`chrome-extension://${id}/${APP_PAGE}`)
    return page
  }

  test('图片：选图 → 压缩成 jpeg 落资源库 → 消息里只留引用，模型拿到一行文字', async () => {
    const page = await openPanel()

    // 附件入口：说明里可以发图片
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

    // ① 核心不变式：请求体里没有图片字节，只有一行引用
    const text = lastUserText()
    expectNoImageBytes(text)
    expect(text, '正文照常发出').toContain('看看这张图')
    // 落库时扩展名按真实 MIME 归一：原图是 png，进库的是重编码后的 jpeg ⇒ 名字变 shot.jpg
    expectAssetPlaceholder(text, 'shot.jpg')

    // ② 落盘回显：气泡里的缩略图由面板按引用**回资源库取回**（消息里没有字节）
    await thumbDataUrl(page)
    await page.close()
  })

  test('刷新面板：缩略图仍能出来 ⇒ 字节确实在资源库里，不在消息里', async () => {
    const page = await openPanel()

    await page.setInputFiles('input[type="file"]', {
      name: 'shot.png',
      mimeType: 'image/png',
      buffer: await makePngBuffer(page, 8, 8),
    })
    const box = page.getByRole('textbox').first()
    await box.fill('刷新前后都该看得见')
    await box.press('Enter')
    await expect(page.getByText(/stub 回复：/)).toBeVisible({ timeout: 25_000 })
    await thumbDataUrl(page)

    // 刷新 ⇒ 面板从会话库读回消息（里面只有引用），再去资源库取字节。
    // 消息里一旦混进过字节，这条会以另一种方式失效；而资源库若没真落盘，缩略图就出不来。
    await page.reload()
    // 等 AI 那轮回复重新渲染出来。锚点不能取用户原话 —— 那句话同时出现在会话标题栏
    // 与假模型的回显里（stub 会复述最后一条 user 文本），getByText 会撞 strict mode。
    await expect(page.getByText(/stub 回复：/), '刷新后历史消息还在').toBeVisible({ timeout: 20_000 })
    await thumbDataUrl(page)
    await page.close()
  })

  test('文本文件：内容拼进正文（带文件名围栏）随消息发出', async () => {
    const page = await openPanel()

    await page.setInputFiles('input[type="file"]', {
      name: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('这条来自附件', 'utf8'),
    })
    const box = page.getByRole('textbox').first()
    await box.fill('读一下附件')
    await box.press('Enter')

    await expect(page.getByText(/stub 回复：/)).toBeVisible({ timeout: 25_000 })

    const text = lastUserText()
    expect(text).toContain('读一下附件')
    expect(text, '文本附件以带文件名的围栏进正文').toContain('【附件：notes.md】')
    expect(text).toContain('这条来自附件')
    // 只带文本文件时不该混进图片痕迹
    expectNoImageBytes(text)
    await page.close()
  })

  test('同一轮里图片与文本文件并存：两条通路互不干扰', async () => {
    const page = await openPanel()

    await page.setInputFiles('input[type="file"]', [
      { name: 'shot.png', mimeType: 'image/png', buffer: await makePngBuffer(page, 4, 4) },
      { name: 'err.log', mimeType: 'text/plain', buffer: Buffer.from('ERROR 第一行\n第二行', 'utf8') },
    ])

    const chips = page.locator('[data-testid="attachment-chips"]')
    await expect(chips).toContainText('shot.png')
    await expect(chips, '图片与文本文件应各占一枚 chip').toContainText('err.log')

    const box = page.getByRole('textbox').first()
    await box.fill('图是界面，日志在附件里')
    await box.press('Enter')
    await expect(page.getByText(/stub 回复：/)).toBeVisible({ timeout: 25_000 })

    const text = lastUserText()
    // 文本附件进正文（带围栏），图片换成一行引用 —— 两条路各归各的
    expect(text).toContain('图是界面，日志在附件里')
    expect(text).toContain('【附件：err.log】')
    expect(text).toContain('ERROR 第一行')
    expectNoImageBytes(text)
    expectAssetPlaceholder(text, 'shot.jpg')
    await page.close()
  })

  test('纯图提问：不写字也能发出去（消息正文允许为空）', async () => {
    const page = await openPanel()

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
    const text = lastUserText()
    // 没有正文，那这一行引用就是模型收到的全部内容 —— 它必须在这里
    expectAssetPlaceholder(text, 'only-image.jpg')
    expectNoImageBytes(text)
    await page.close()
  })

  test('粘贴图片（Ctrl+V）与拖拽进输入框：两条真实路径都能带图发出', async () => {
    const page = await openPanel()
    const png = await makePngBuffer(page, 4, 4)

    // ① 粘贴
    await pasteImage(page, png)
    await expect(page.locator('[data-testid="attachment-chips"]'), '粘贴后应出现附件 chip').toContainText('pasted.png')
    await page.locator('[data-testid="remove-attachment"]').click()
    await expect(page.locator('[data-testid="attachment-chips"]')).toHaveCount(0)

    // ② 拖拽
    await dropImage(page, png)
    await expect(page.locator('[data-testid="attachment-chips"]'), '拖拽进表单后应出现附件 chip').toContainText('dropped.png')

    const box = page.getByRole('textbox').first()
    await box.fill('两条路各来一张')
    await box.press('Enter')
    await expect(page.getByText(/stub 回复：/)).toBeVisible({ timeout: 25_000 })

    const text = lastUserText()
    expectAssetPlaceholder(text, 'dropped.jpg')
    expectNoImageBytes(text)
    await page.close()
  })

  test('大图会被压到长边上限（不只是换了格式，尺寸真的降下来）', async () => {
    const page = await openPanel()

    // 3000×2000 的纯色图：PNG 本身很小（纯色压得动），但像素尺寸必须被压下来
    await page.setInputFiles('input[type="file"]', {
      name: 'huge.png',
      mimeType: 'image/png',
      buffer: await makePngBuffer(page, 3000, 2000),
    })
    const box = page.getByRole('textbox').first()
    await box.fill('这张很大')
    await box.press('Enter')
    await expect(page.getByText(/stub 回复：/)).toBeVisible({ timeout: 25_000 })

    // 压缩后的字节取不到「从请求体里读」那条路了（字节本就不该进请求）——
    // 改从气泡缩略图拿：它就是资源库里那份压缩后的原图，量的还是同一份数据
    const dataUrl = await thumbDataUrl(page)

    // 在页面里解码收到的 data URL，量真实像素（等比缩放：3000×2000 → 1568×1045）
    const size = await page.evaluate(async (url) => {
      const img = new Image()
      img.src = url
      await img.decode()
      return { width: img.naturalWidth, height: img.naturalHeight }
    }, dataUrl)
    expect(size.width, '长边应被压到上限').toBe(1568)
    expect(size.height, '短边按比例缩放').toBe(1045)
    await page.close()
  })

  test('点气泡里的缩略图：面板内弹出大图 + 下载，不开新标签', async () => {
    const page = await openPanel()

    await page.setInputFiles('input[type="file"]', {
      name: 'shot.png',
      mimeType: 'image/png',
      buffer: await makePngBuffer(page, 40, 24),
    })
    const box = page.getByRole('textbox').first()
    await box.fill('看一眼')
    await box.press('Enter')
    await expect(page.getByText(/stub 回复：/)).toBeVisible({ timeout: 25_000 })
    await thumbDataUrl(page)

    const pagesBefore = context!.pages().length
    await page.locator('[data-testid="preview-image"]').click()

    const dialog = page.locator('[data-testid="image-preview"]')
    await expect(dialog, '应在面板内弹出预览').toBeVisible()
    await expect(dialog.locator('img')).toHaveAttribute('src', /^data:image\/jpeg/)
    // 下载名取自引用（落库时扩展名已按真实 MIME 归一），不是用户原始文件名
    await expect(dialog.locator('[data-testid="download-image"]')).toHaveAttribute('download', 'shot.jpg')

    // 关键：没有新标签被打开 —— data: 不允许顶层导航，这正是走面板内弹窗的原因
    await page.waitForTimeout(400)
    expect(context!.pages().length, '不该开新标签').toBe(pagesBefore)
    await page.close()
  })
})
