// 本地「模型 stub」：一个 OpenAI 兼容的假模型服务，供 e2e 顶替真模型。
//
// 为什么需要它：会话只有走完一次 `chat:start` 才产生（落库），而它要模型 ⇒ 没有可用模型，
// 「一个标签页一条会话 / 归属 / 删除门 / 生成不中断」这类手测项就永远只能靠人点。产品支持自定义
// `baseUrl`（`ModelProfile.baseUrl`；`useFullUrl=false` 时追加 `/chat/completions`），所以测试里
// 起一个本地服务指过去即可 —— 回复内容由我们写死，断言因此是确定的、零成本、零网络。
//
// 覆盖两种请求形态（两条都在 2026-09-21 实测通过）：
//   · 非流式 JSON —— `window.api.model.testChat()` 走这条（设置页的「测试连通性」）；
//   · 流式 SSE —— 真对话链路走这条（offscreen 的 `@ai-sdk/openai-compatible`）。
import * as http from 'node:http'

export interface ModelStubHit {
  url: string
  /** 本次请求是否要求流式 */
  stream: boolean
  /** 最后一条 user 消息的文本（默认回复会回显它） */
  lastUser: string
}

export interface ModelStub {
  /** 填进 `ModelProfile.baseUrl` 的地址（不要再加 /chat/completions） */
  baseUrl: string
  /** 收到的全部请求（断言用，按时间顺序） */
  hits: ModelStubHit[]
}

export interface ModelStubOptions {
  /** 自定义回复文本；给了就完全取代默认的「stub 回复：<最后一条用户消息>」 */
  reply?: (lastUser: string, hit: ModelStubHit) => string
  /** 模型 id（回包里的 model 字段，默认 stub-model） */
  model?: string
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
}

/**
 * 起一个假模型服务（127.0.0.1 随机端口）。调用方负责在收尾时 `server.close()`。
 * 返回的 `hits` 是同一个数组引用，断言随时可读。
 */
export async function startModelStub(opts: ModelStubOptions = {}): Promise<{
  stub: ModelStub
  server: http.Server
  replyText: (lastUser: string) => string
}> {
  const modelId = opts.model ?? 'stub-model'
  const hits: ModelStubHit[] = []
  const replyText = (lastUser: string) => (opts.reply ? opts.reply(lastUser, hits[hits.length - 1]) : `stub 回复：${lastUser}`)

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let body: { stream?: boolean; messages?: Array<{ role: string; content: string }> } = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        /* 空体按空对象处理：仍然回一句，避免调用方干等 */
      }
      const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? ''
      const hit: ModelStubHit = { url: req.url ?? '', stream: !!body.stream, lastUser }
      hits.push(hit)
      const text = replyText(lastUser)

      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json', ...CORS })
        res.end(
          JSON.stringify({
            id: 'chatcmpl-stub',
            object: 'chat.completion',
            created: 1,
            model: modelId,
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
        return
      }

      // 流式：分两片吐字 + finish + [DONE]（AI SDK 认这个形状）
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...CORS })
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        'data: ' +
        JSON.stringify({
          id: 'chatcmpl-stub',
          object: 'chat.completion.chunk',
          created: 1,
          model: modelId,
          choices: [{ index: 0, delta, finish_reason: finish }],
        }) +
        '\n\n'
      res.write(chunk({ role: 'assistant', content: text.slice(0, 5) }, null))
      res.write(chunk({ content: text.slice(5) }, null))
      res.write(chunk({}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
  return { stub: { baseUrl: `http://127.0.0.1:${port}`, hits }, server, replyText }
}
