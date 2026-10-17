// 对话链路的端测：用本地模型 stub 把 `chat:start` 在无头 CI 上跑完。
//
// 意义：
//   · 会话只有走完一次 `chat:start` 才产生（落库）⇒ 没有可用模型，「一个标签页一条会话 / 归属 /
//     删除门 / 生成不中断」这类手测项只能靠人点。本 spec 把这条链路在 CI 上打通，
//     后续的会话类断言（见 conversation-scope.spec.ts）可以建在它上面。
//   · 在此之前，CI 里**没有任何**用例真正跑过对话链路（只有 SW 命令面 / 注入面 / 页面加载）。
//
// 做法：起一个 OpenAI 兼容的假模型服务（`scripts/model-stub.mts`），经设置页表单存进配置
// （见 e2e/model-config.ts）——回复内容由我们写死，故断言确定、零成本、零网络。
// 真模型不会出现在 CI 里：没有 key、不该为此花钱、回复不确定。
import { test, expect, type BrowserContext } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extensionIdFromServiceWorker, getServiceWorker, launchExtensionContext } from './extension'
import { startModelStub } from '../scripts/model-stub.mts'
import { saveStubModel } from './model-config'
import { readAssistantTotalTokens } from './chat-db'

/** 浮层页：对话界面本体（配置模型要去工作台的设置页，两者同源共享存储） */
const APP_PAGE = 'floatpanel.html'
const WORKBENCH_PAGE = 'workbench.html'

test.describe.serial('对话链路（本地模型 stub）', () => {
  let context: BrowserContext | undefined
  let profileDir = ''
  let stub: Awaited<ReturnType<typeof startModelStub>>

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-chat-e2e-'))
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

  test('连通性测试（设置页「测试连接」，非流式）打到 stub 通过', async () => {
    const id = extensionIdFromServiceWorker(await getServiceWorker(context!))
    const page = await context!.newPage()
    await page.goto(`chrome-extension://${id}/${WORKBENCH_PAGE}`)
    // 只填不存：这条只验非流式请求，落盘留给下一条用例
    await saveStubModel(page, { baseUrl: stub.stub.baseUrl }, { test: true, save: false })
    expect(stub.stub.hits[0]?.stream, 'testChat 是非流式').toBe(false)
    await page.close()
  })

  test('发一句 → offscreen 流式打到 stub → UI 显示写死的回复', async () => {
    const id = extensionIdFromServiceWorker(await getServiceWorker(context!))
    const page = await context!.newPage()
    // 存配置：设置页表单，首条配置自动成为当前模型
    await page.goto(`chrome-extension://${id}/${WORKBENCH_PAGE}`)
    await saveStubModel(page, { baseUrl: stub.stub.baseUrl })
    // 回到浮层，走真人路径
    await page.goto(`chrome-extension://${id}/${APP_PAGE}`)

    // 填字 + 回车
    const box = page.getByRole('textbox').first()
    await box.fill('你好')
    await box.press('Enter')

    await expect(page.getByText(/stub 回复：你好/), 'UI 应显示 stub 写死的回复（说明整条流式链路通了）').toBeVisible({
      timeout: 25_000,
    })
    const streamed = stub.stub.hits.filter((h) => h.stream)
    expect(streamed.length, '真链路走流式').toBeGreaterThanOrEqual(1)
    expect(streamed[streamed.length - 1]?.lastUser, 'stub 收到了我们发的那句话').toContain('你好')
    // baseUrl 就是完整端点地址、原样发出。SDK 默认会把 baseURL 与固定的 /chat/completions 拼起来，
    // 若那层拼接没被 fetch 覆盖挡住，这里会看到 /chat/completions/chat/completions。
    expect(streamed[streamed.length - 1]?.url, '地址原样发出，没有被二次拼接').toBe('/chat/completions')

    // 用量看门：stub 在流末发一片「choices 空数组 + usage」，SDK 取走它写进 finish 事件，
    // chat-host 再推成 data-usage part 并落盘到 message.usage。三环断掉任一环，这里都读不到正数。
    await expect
      .poll(() => readAssistantTotalTokens(page), {
        timeout: 10_000,
        message: '用量应随 assistant 消息落盘（stub 末片的 usage 被 SDK 取到、再由 chat-host 写进 data-usage）',
      })
      .toBeGreaterThan(0)
    await page.close()
  })
})
