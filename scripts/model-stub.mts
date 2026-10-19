// 本地「模型 stub」：一个 OpenAI 兼容的假模型服务 —— e2e 用它顶替真模型，dev 手测时也由它代劳。
//
// 为什么需要它：会话只有走完一次 `chat:start` 才产生（落库），而它要模型 ⇒ 没有可用模型，
// 「一个标签页一条会话 / 归属 / 删除门 / 生成不中断」这类手测项就永远只能靠人点。产品支持自定义
// `baseUrl`（`ModelProfile.baseUrl`，即**完整的 Chat Completions 端点地址**），所以起一个本地服务
// 指过去即可 —— 回复内容由我们写死，断言因此是确定的、零成本、零网络。
//
// 覆盖两种请求形态（均实测通过）：
//   · 非流式 JSON —— 设置页的「测试连接」走这条（`model-store.testChatResult`）；
//   · 流式 SSE —— 真对话链路走这条（offscreen 的 `@ai-sdk/openai-compatible`）。
// 两条都带 token 用量：非流式的 `usage` 直接放回包里；流式按 OpenAI `include_usage` 的形状补一片
// 「`choices` 空数组 + `usage`」的末片（SDK 取走它并写进 finish 事件 → 产品侧的 `data-usage`）。
//
// 谁在用：
//   · e2e —— `import { startModelStub } from '../scripts/model-stub.mts'`，随机端口（多个 spec 并行不撞）；
//   · dev —— `scripts/dev.mts` 起在固定端口上并把地址打印出来，手填进「设置 → 添加模型 → 自定义」。
//
// 内置调试触发（**不给 `plan` 时**生效）：用户消息恰好是下面几个词之一 → 回对应的工具调用；本轮工具结果
// 已回流（按最后一条用户消息划界）→ 收尾，并把结果摘要成一句人话（含失败原因）。用途：dev 手测跑通「要扩展
// 侧真跑一遍」的工具链（`page_snapshot` / `page_env_read` 这类：假模型只负责发起，采集真身是页面检查器件），
// 不必手写 plan。连续多轮各打各的触发词也各跑各的 —— 历史里上一轮的工具结果不算本轮。
// 精确整句匹配（trim + 大小写不敏感）是刻意的：自然语句一律不触发，免得误伤手测里的日常对话。
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** 默认端口：dev 与 `pnpm run model:serve` 共用。固定端口是刻意的 —— 已保存的模型配置里存的是
 *  完整地址，随机端口会让它每次重启都失效。 */
export const DEFAULT_PORT = 5199

export interface ModelStubHit {
  url: string
  /** 本次请求是否要求流式 */
  stream: boolean
  /** 最后一条 user 消息的文本（默认回复会回显它） */
  lastUser: string
  /** 本次请求带上的 messages（断言「工具结果有没有回流」「上下文有没有带上」用） */
  messages: Array<{ role: string; content?: unknown }>
  /** 本次请求声明的工具名（断言「app 把工具声明发给模型了」用） */
  toolNames: string[]
}

/** 一次回复：给文本，或给工具调用（给工具调用时文本可省） */
export interface StubReply {
  text?: string
  /** 非空时先吐一片 `reasoning_content`（OpenAI 兼容形状，SDK 转成思考过程），再吐正文 / 工具调用 */
  reasoning?: string
  /** 要模型发起的工具调用（多步循环靠它驱动：第 1 次 spec、第 2 次 apply…） */
  toolCalls?: Array<{ name: string; args?: unknown }>
}

export interface ModelStub {
  /** 填进 `ModelProfile.baseUrl` 的地址（完整端点，链路侧原样请求） */
  baseUrl: string
  /** 实际监听端口（dev 打印地址 / 断言取用） */
  port: number
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
   *
   * **给了 plan 就完全按 plan**；不给时启用内置调试触发（消息整句是「快照」→ page_snapshot、
   * 「页面环境」→ page_env_read，工具结果回流后自动收尾复述），供 dev 手测走通工具链。
   */
  plan?: (hit: ModelStubHit, index: number) => StubReply | undefined
  /** 模型 id（回包里的 model 字段，默认 stub-model） */
  model?: string
  /** 每次响应都带的思考过程文本（OpenAI 兼容的 `reasoning_content` 片） */
  reasoning?: string
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
  /** 监听端口；缺省 0（随机端口，e2e 并行不撞） */
  port?: number
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
      .map((p) =>
        p && typeof p === 'object' && 'text' in p
          ? String((p as { text?: unknown }).text ?? '')
          : '',
      )
      .join('')
  }
  return ''
}

/** 粗估 token（约 4 字符 1 token）。stub 不加载分词器，只为让用量一栏有值可看；确定性即可，不追求准。 */
function estimateTokens(text: unknown): number {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4))
}

/** 内置调试触发的词表：整句匹配（trim + 小写）。每组都是「同一个工具的几种叫法」。 */
const BUILTIN_TRIGGERS: Record<string, string[]> = {
  page_snapshot: ['快照', '页面快照'],
  page_env_read: ['页面环境'],
}

/** 一句话该怎么触发：命中返回工具名，未命中返回 null */
function builtinTriggerFor(message: unknown): string | null {
  const text = String(message ?? '')
    .trim()
    .toLowerCase()
  if (!text) return null
  for (const [name, words] of Object.entries(BUILTIN_TRIGGERS)) {
    if (words.some((w) => w.toLowerCase() === text)) return name
  }
  return null
}

/**
 * 把一条工具结果摘成一句人话 —— 手测时不用去翻工具回执原文，成败与关键读数一眼可见。
 * 形状不认识时退回「原样截断」，至少能看出「有东西回来了」。
 */
function summarizeToolResult(raw: unknown): string {
  const text = String(raw ?? '')
  let obj: unknown = null
  try {
    obj = JSON.parse(text)
  } catch {
    /* 不是 JSON：下面按原文截断 */
  }
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>
    if (o.ok === false) return `❌ 没采到：${String(o.error ?? '工具返回 ok:false')}`
    if (typeof o.html === 'string') {
      return `✅ 快照到手：${String(o.pageUrl ?? '(无 pageUrl)')} · HTML ${o.html.length} 字符`
    }
    if (o.viewport) {
      const vp = o.viewport as { width: unknown; height: unknown }
      return `✅ 页面环境：视口 ${vp.width}×${vp.height} · dpr=${String(o.dpr)} · UA=${String(o.ua ?? '').slice(0, 60)}`
    }
    return `✅ 工具已返回：${Object.keys(o).join(' / ')}`
  }
  return `工具已返回（${text.length} 字符）：${text.slice(0, 200)}`
}

/**
 * 本轮已回流的工具结果：**最后一条 user 消息之后**的那些 tool 消息。
 * 判据必须按「轮」算、不能扫全部历史 —— 多轮对话里上一轮的工具结果仍留在 messages 中，
 * 扫全量会把「新一轮提问」误判成「本轮工具已回流」，于是这轮直接复述上一轮的回执、
 * 永不发起新工具（真机踩到过：打「页面环境」回的是上一轮的「快照到手」）。
 */
function currentTurnToolMessages(messages: ModelStubHit['messages']) {
  const lastUser = messages.map((m) => m.role).lastIndexOf('user')
  return messages.slice(lastUser + 1).filter((m) => m.role === 'tool')
}

/**
 * 没给 `plan` 时的默认脚本：① 命中触发词 → 发对应工具调用；② 本轮工具结果已回流 → 收尾复述。
 * 只看本轮，因此天然只走两步、不会自激，多轮对话也不会串轮。
 * 未命中触发词返回 undefined，调用方照常退回普通文本回复。
 */
function builtinPlan(hit: ModelStubHit): StubReply | undefined {
  const results = currentTurnToolMessages(hit.messages)
  if (results.length) {
    const lines = results.map((m) => summarizeToolResult(flattenText(m.content)))
    return { text: `${lines.join('\n')}\n（假模型调试回执）` }
  }
  const name = builtinTriggerFor(hit.lastUser)
  return name ? { toolCalls: [{ name, args: {} }] } : undefined
}

/** 请求体的形状按需取用：stub 只关心这几个字段，其余原样忽略 */
interface StubRequestBody {
  stream?: boolean
  messages?: ModelStubHit['messages']
  tools?: Array<{ function?: { name?: string } }>
}

/**
 * 起一个假模型服务（默认 127.0.0.1 随机端口）。调用方负责在收尾时关掉返回的 server。
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
  const replyText = (lastUser: string) =>
    opts.reply ? opts.reply(lastUser, hits[hits.length - 1]!) : `stub 回复：${lastUser}`

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      let body: StubRequestBody = {}
      try {
        body = JSON.parse(raw || '{}') as StubRequestBody
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
      // 给了 plan 就完全按 plan（e2e 要精确控制多步循环）；没给才启用内置调试触发
      const planned = opts.plan ? opts.plan(hit, hits.length - 1) : builtinPlan(hit)
      const text = planned?.text ?? replyText(hit.lastUser)
      const toolCalls = planned?.toolCalls ?? []
      const reasoning = planned?.reasoning ?? opts.reasoning ?? ''

      // 延时在**记录之后、吐字节之前**：此刻 hits 里已有这条请求（断言「生成已开始」读得到），
      // 而对端还在等首字节 —— 正是「任务在跑」的形态。
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs))

      if (!body.stream) {
        // 非流式只服务 testChat（它只验 HTTP 通不通），不带工具调用
        res.writeHead(200, { 'content-type': 'application/json', ...CORS })
        res.end(
          JSON.stringify({
            id: 'chatcmpl-stub',
            object: 'chat.completion',
            created: 1,
            model: modelId,
            choices: [
              { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        ...CORS,
      })
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

      // 末片用量：OpenAI `include_usage` 的形状 —— `choices` 为空数组、`usage` 有值。
      // SDK 对空 choices 是安全跳过（`choice?.delta == null` → return），只取走 usage，
      // 并在流末把累计值写进 finish 事件；产品侧的 `data-usage` part 由此而来。
      // 不放在 `chunk()` 里，因为它的 choices 恒有一项（而用量片必须为空数组）。
      const promptTokens = estimateTokens(messages.map((m) => flattenText(m.content)).join(''))
      const completionTokens = estimateTokens(text)
      const usageFrame =
        'data: ' +
        JSON.stringify({
          id: 'chatcmpl-stub',
          object: 'chat.completion.chunk',
          created: 1,
          model: modelId,
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        }) +
        '\n\n'

      if (toolCalls.length) {
        // OpenAI 形状的工具调用：先给 id/name/type，再逐片补 arguments，最后 finish_reason=tool_calls
        if (reasoning) res.write(chunk({ role: 'assistant', reasoning_content: reasoning }, null))
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
          res.write(
            chunk(
              {
                tool_calls: [{ index: i, function: { arguments: JSON.stringify(tc.args ?? {}) } }],
              },
              null,
            ),
          )
        })
        res.write(chunk({}, 'tool_calls'))
        res.write(usageFrame)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      // 流式文本：分两片吐字 + finish + [DONE]（AI SDK 认这个形状）；带 reasoning 时先吐思考片
      if (reasoning) res.write(chunk({ role: 'assistant', reasoning_content: reasoning }, null))
      res.write(chunk({ role: 'assistant', content: text.slice(0, 5) }, null))
      if (opts.holdAfterFirstChunkMs) {
        await new Promise((resolve) => setTimeout(resolve, opts.holdAfterFirstChunkMs))
      }
      res.write(chunk({ content: text.slice(5) }, null))
      res.write(chunk({}, 'stop'))
      res.write(usageFrame)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port),
    )
  })
  return {
    // 完整端点地址：链路侧原样请求，所以这里必须带上 /chat/completions（不再由调用方拼）
    stub: { baseUrl: `http://127.0.0.1:${port}/chat/completions`, port, hits },
    server,
    replyText,
    setOptions: (patch) => Object.assign(opts, patch),
  }
}

// —— CLI：pnpm run model:serve / node scripts/model-stub.mts ——
// 用途：不跑 dev 的手测（加载已构建的 .output 产物）也要有个假模型可接，与 `probe:serve` 对称。
const argv1 = process.argv[1]
const isCli = !!argv1 && fileURLToPath(import.meta.url) === resolve(argv1)
if (isCli) {
  const argPort = process.argv.indexOf('--port')
  const port = Number(
    argPort >= 0 ? process.argv[argPort + 1] : process.env.DL_MODEL_STUB_PORT || DEFAULT_PORT,
  )
  const model = await startModelStub({ port: Number.isFinite(port) ? port : DEFAULT_PORT })
  console.log(`[假模型] 已就绪：${model.stub.baseUrl}`)
  console.log('[假模型] 填进「设置 → 添加模型 → 服务商选自定义 → 接口地址」（密钥可留空）')
  console.log('[假模型] 保持本进程运行；Ctrl-C 结束')
  console.log('[假模型] 调试触发：消息整句发「快照」或「页面环境」，即可走通对应的工具链')
}
