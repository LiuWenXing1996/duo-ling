// 对话链路的端测：用本地模型 stub 把 `chat:start` 在无头 CI 上跑完。
//
// 意义：
//   · 会话只有走完一次 `chat:start` 才产生（落库）⇒ 没有可用模型，「一个标签页一条会话 / 归属 /
//     删除门 / 生成不中断」这类手测项只能靠人点。本 spec 把这条链路在 CI 上打通，
//     后续的会话类断言（见 conversation-scope.spec.ts）可以建在它上面。
//   · 在此之前，CI 里**没有任何**用例真正跑过对话链路（只有 SW 命令面 / 注入面 / 页面加载）。
//
// 做法：起一个 OpenAI 兼容的假模型服务（`scripts/model-stub.mjs`），经 `window.api.model.save`
// 存进配置并激活（就是设置页走的那条路）——回复内容由我们写死，故断言确定、零成本、零网络。
// 真模型不会出现在 CI 里：没有 key、不该为此花钱、回复不确定。
import { test, expect, type BrowserContext } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extensionIdFromServiceWorker, getServiceWorker, launchExtensionContext } from './extension'
import { startModelStub } from '../scripts/model-stub.mjs'

/** 浮层页（`installWindowApi()` 在这里挂上 window.api，设置页同源） */
const APP_PAGE = 'floatpanel.html'

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

  test('连通性测试（window.api.model.testChat，非流式）打到 stub 通过', async () => {
    const id = extensionIdFromServiceWorker(await getServiceWorker(context!))
    const page = await context!.newPage()
    await page.goto(`chrome-extension://${id}/${APP_PAGE}`)
    const res = await page.evaluate(
      async (cfg) =>
        await (window as unknown as { api: { model: { testChat: (c: unknown) => Promise<unknown> } } }).api.model.testChat(cfg),
      { baseUrl: stub.stub.baseUrl, apiKey: 'sk-stub', model: 'stub-model' },
    )
    expect(res, '连通性测试应返回 ok（模型地址与 Key 的拼接规则被真跑过一遍）').toEqual({ ok: true })
    expect(stub.stub.hits[0]?.stream, 'testChat 是非流式').toBe(false)
    await page.close()
  })

  test('发一句 → offscreen 流式打到 stub → UI 显示写死的回复', async () => {
    const id = extensionIdFromServiceWorker(await getServiceWorker(context!))
    const page = await context!.newPage()
    await page.goto(`chrome-extension://${id}/${APP_PAGE}`)

    // 存配置 + 激活：设置页保存模型时走的就是 window.api.model.save / setActive
    await page.evaluate(
      async (cfg) => {
        const api = (
          window as unknown as {
            api: { model: { save: (c: unknown) => Promise<{ id: string }>; setActive: (id: string) => Promise<void> } }
          }
        ).api
        const p = await api.model.save(cfg)
        await api.model.setActive(p.id)
        return p.id
      },
      { name: 'stub', baseUrl: stub.stub.baseUrl, apiKey: 'sk-stub', model: 'stub-model' },
    )

    // 真人路径：填字 + 回车
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
    const readUsage = async (): Promise<number> =>
      await page.evaluate(async () => {
        const api = (
          window as unknown as {
            api: {
              conversation: {
                list: () => Promise<Array<{ id: string }>>
                messages: (
                  id: string,
                ) => Promise<Array<{ role: string; usage?: { totalTokens?: number } }>>
              }
            }
          }
        ).api
        const list = await api.conversation.list()
        if (!list.length) return 0
        const msgs = await api.conversation.messages(list[0]!.id)
        return msgs.find((m) => m.role === 'assistant')?.usage?.totalTokens ?? 0
      })

    await expect
      .poll(readUsage, {
        timeout: 10_000,
        message: '用量应随 assistant 消息落盘（stub 末片的 usage 被 SDK 取到、再由 chat-host 写进 data-usage）',
      })
      .toBeGreaterThan(0)
    await page.close()
  })
})
