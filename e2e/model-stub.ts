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
  /** 本次请求带上的 messages（断言「工具结果有没有回流」「上下文有没有带上」用） */
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown }>
  /** 本次请求声明的工具名（断言「app 把工具声明发给模型了」用） */
  toolNames: string[]
}

/** 一次回复：给文本，或给工具调用（给工具调用时文本可省） */
export interface StubReply {
  text?: string
  /** 要模型发起的工具调用（多步循环靠它驱动：第 1 次 spec、第 2 次 apply…） */
  toolCalls?: Array<{ name: string; args?: unknown }>
}

export interface ModelStub {
  /** 填进 `ModelProfile.baseUrl` 的地址（不要再加 /chat/completions） */
  baseUrl: string
  /** 收到的全部请求（断言用，按时间顺序） */
  hits: ModelStubHit[]
}

export interface ModelStubOptions {
  /** 默认回复文本（不给 plan 时用）；默认回显最后一条用户消息 */
  reply?: (lastUser: string, hit: ModelStubHit) => string
  /**
   * 按「第几次请求」脚本化回复 —— 多步工具循环要靠它：
   * 第 1 次请求（只有用户消息）发 script_spec、第 2 次（带回 spec 结果）发 script_apply、第 3 次收尾。
   * 返回 undefined 时退回 `reply` 的文本。
   */
  plan?: (hit: ModelStubHit, index: number) => StubReply | undefined
  /** 模型 id（回包里的 model 字段，默认 stub-model） */
  model?: string
  /**
   * **首片文本之后**的延时（ms）：制造「已经吐了内容、但还没结束」的窗口 ——
   * 端测要在这段时间里中止任务，验「半截照样落盘」（与 delayMs 的区别：那个是吐字节之前）。
   */
  holdAfterFirstChunkMs?: number
  /**
   * 响应前的延时（ms）：把「生成中」的窗口拉长 —— 端测要在这段时间里做断言
   * （例如收起浮层后按钮是否已在转圈）。此刻既没吐字节也没收尾，正是「任务在跑」的形态。
   * 不设则立即响应。注意别越过 offscreen 的流式静默守卫（默认 60s）。
   */
  delayMs?: number
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
}

function flattenText(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    return v
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : ''))
      .join('')
  }
  return ''
}

/**
 * 起一个假模型服务（127.0.0.1 随机端口）。调用方负责在收尾时 `server.close()`。
 * 返回的 `hits` 是同一个数组引用，断言随时可读。
 */
export async function startModelStub(opts: ModelStubOptions = {}): Promise<{
  stub: ModelStub
  server: http.Server
  replyText: (lastUser: string) => string
  /** 运行期改配置：同一个实例在不同用例里需要不同节奏（每次请求都读当前值，改完即生效） */
  setOptions: (patch: ModelStubOptions) => void
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
    req.on('end', async () => {
      let body: {
        stream?: boolean
        messages?: Array<{ role: string; content?: unknown; tool_calls?: unknown }>
        tools?: Array<{ function?: { name?: string } }>
      } = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        /* 空体按空对象处理：仍然回一句，避免调用方干等 */
      }
      const messages = body.messages ?? []
      const lastUserRaw = [...messages].reverse().find((m) => m.role === 'user')?.content
      const hit: ModelStubHit = {
        url: req.url ?? '',
        stream: !!body.stream,
        lastUser: flattenText(lastUserRaw),
        messages,
        toolNames: (body.tools ?? []).map((t) => t.function?.name ?? '').filter(Boolean),
      }
      hits.push(hit)
      const planned = opts.plan?.(hit, hits.length - 1)
      const text = planned?.text ?? replyText(hit.lastUser)
      const toolCalls = planned?.toolCalls ?? []

      // 延时在**记录之后、吐字节之前**：此刻 hits 里已有这条请求（断言「生成已开始」读得到），
      // 而对端还在等首字节 —— 正是「任务在跑」的形态。
      if (opts.delayMs) await new Promise<void>((resolve) => setTimeout(resolve, opts.delayMs))

      if (!body.stream) {
        // 非流式只服务 testChat（它只验 HTTP 通不通），不带工具调用
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

      if (toolCalls.length) {
        // OpenAI 形状的工具调用：先给 id/name/type，再逐片补 arguments，最后 finish_reason=tool_calls
        res.write(
          chunk(
            {
              role: 'assistant',
              tool_calls: toolCalls.map((tc, i) => ({
                index: i,
                id: `call_${hits.length}_${i}`,
                type: 'function',
                function: { name: tc.name, arguments: '' },
              })),
            },
            null,
          ),
        )
        toolCalls.forEach((tc, i) => {
          res.write(chunk({ tool_calls: [{ index: i, function: { arguments: JSON.stringify(tc.args ?? {}) } }] }, null))
        })
        res.write(chunk({}, 'tool_calls'))
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      // 流式文本：分两片吐字 + finish + [DONE]（AI SDK 认这个形状）
      res.write(chunk({ role: 'assistant', content: text.slice(0, 5) }, null))
      if (opts.holdAfterFirstChunkMs) {
        await new Promise<void>((resolve) => setTimeout(resolve, opts.holdAfterFirstChunkMs))
      }
      res.write(chunk({ content: text.slice(5) }, null))
      res.write(chunk({}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
  return {
    stub: { baseUrl: `http://127.0.0.1:${port}`, hits },
    server,
    replyText,
    setOptions: (patch) => Object.assign(opts, patch),
  }
}
