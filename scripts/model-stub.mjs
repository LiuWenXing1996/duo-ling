// 本地「模型 stub」：一个 OpenAI 兼容的假模型服务 —— e2e 用它顶替真模型，dev 手测时也由它代劳。
//
// 为什么需要它：会话只有走完一次 `chat:start` 才产生（落库），而它要模型 ⇒ 没有可用模型，
// 「一个标签页一条会话 / 归属 / 删除门 / 生成不中断」这类手测项就永远只能靠人点。产品支持自定义
// `baseUrl`（`ModelProfile.baseUrl`，即**完整的 Chat Completions 端点地址**），所以起一个本地服务
// 指过去即可 —— 回复内容由我们写死，断言因此是确定的、零成本、零网络。
//
// 覆盖两种请求形态（均实测通过）：
//   · 非流式 JSON —— `window.api.model.testChat()` 走这条（设置页的「测试连接」）；
//   · 流式 SSE —— 真对话链路走这条（offscreen 的 `@ai-sdk/openai-compatible`）。
// 两条都带 token 用量：非流式的 `usage` 直接放回包里；流式按 OpenAI `include_usage` 的形状补一片
// 「`choices` 空数组 + `usage`」的末片（SDK 取走它并写进 finish 事件 → 产品侧的 `data-usage`）。
//
// 谁在用：
//   · e2e —— `import { startModelStub } from '../scripts/model-stub.mjs'`，随机端口（多个 spec 并行不撞）；
//   · dev —— `scripts/dev.mjs` 起在固定端口上并把地址打印出来，手填进「设置 → 添加模型 → 自定义」。
//
// 内置调试触发（**不给 `plan` 时**生效）：用户消息恰好是下面几个词之一 → 回对应的工具调用；本轮工具结果
// 已回流（按最后一条用户消息划界）→ 收尾，并把结果摘要成一句人话（含失败原因）。用途：dev 手测跑通「要扩展
// 侧真跑一遍」的工具链（`page_snapshot` / `page_env_read` 这类：假模型只负责发起，采集真身是页面检查器件），
// 不必手写 plan。连续多轮各打各的触发词也各跑各的 —— 历史里上一轮的工具结果不算本轮。
// 精确整句匹配（trim + 大小写不敏感）是刻意的：自然语句一律不触发，免得误伤手测里的日常对话。
import * as http from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** 默认端口：dev 与 `npm run model:serve` 共用。固定端口是刻意的 —— 已保存的模型配置里存的是
 *  完整地址，随机端口会让它每次重启都失效。 */
export const DEFAULT_PORT = 5199

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
}

function flattenText(v) {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    return v
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text ?? '') : ''))
      .join('')
  }
  return ''
}

/** 粗估 token（约 4 字符 1 token）。stub 不加载分词器，只为让用量一栏有值可看；确定性即可，不追求准。 */
function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4))
}

/** 内置调试触发的词表：整句匹配（trim + 小写）。每组都是「同一个工具的几种叫法」。 */
const BUILTIN_TRIGGERS = {
  page_snapshot: ['快照', '页面快照'],
  page_env_read: ['页面环境'],
}

/** 一句话该怎么触发：命中返回工具名，未命中返回 null */
function builtinTriggerFor(message) {
  const text = String(message ?? '').trim().toLowerCase()
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
function summarizeToolResult(raw) {
  const text = String(raw ?? '')
  let obj = null
  try {
    obj = JSON.parse(text)
  } catch {
    /* 不是 JSON：下面按原文截断 */
  }
  if (obj && typeof obj === 'object') {
    if (obj.ok === false) return `❌ 没采到：${obj.error ?? '工具返回 ok:false'}`
    if (typeof obj.html === 'string') {
      return `✅ 快照到手：${obj.pageUrl ?? '(无 pageUrl)'} · HTML ${obj.html.length} 字符`
    }
    if (obj.viewport) {
      const vp = `${obj.viewport.width}×${obj.viewport.height}`
      return `✅ 页面环境：视口 ${vp} · dpr=${obj.dpr} · UA=${String(obj.ua ?? '').slice(0, 60)}`
    }
    return `✅ 工具已返回：${Object.keys(obj).join(' / ')}`
  }
  return `工具已返回（${text.length} 字符）：${text.slice(0, 200)}`
}

/**
 * 本轮已回流的工具结果：**最后一条 user 消息之后**的那些 tool 消息。
 * 判据必须按「轮」算、不能扫全部历史 —— 多轮对话里上一轮的工具结果仍留在 messages 中，
 * 扫全量会把「新一轮提问」误判成「本轮工具已回流」，于是这轮直接复述上一轮的回执、
 * 永不发起新工具（真机踩到过：打「页面环境」回的是上一轮的「快照到手」）。
 */
function currentTurnToolMessages(messages) {
  const lastUser = messages.map((m) => m.role).lastIndexOf('user')
  return messages.slice(lastUser + 1).filter((m) => m.role === 'tool')
}

/**
 * 没给 `plan` 时的默认脚本：① 命中触发词 → 发对应工具调用；② 本轮工具结果已回流 → 收尾复述。
 * 只看本轮，因此天然只走两步、不会自激，多轮对话也不会串轮。
 * 未命中触发词返回 undefined，调用方照常退回普通文本回复。
 */
function builtinPlan(hit) {
  const results = currentTurnToolMessages(hit.messages)
  if (results.length) {
    const lines = results.map((m) => summarizeToolResult(flattenText(m.content)))
    return { text: `${lines.join('\n')}\n（假模型调试回执）` }
  }
  const name = builtinTriggerFor(hit.lastUser)
  return name ? { toolCalls: [{ name, args: {} }] } : undefined
}

/**
 * 起一个假模型服务（默认 127.0.0.1 随机端口）。调用方负责在收尾时关掉返回的 server。
 * 返回的 `hits` 是同一个数组引用，断言随时可读。
 *
 * @param {object} [opts]
 * @param {(lastUser: string, hit: object) => string} [opts.reply] 默认回复文本；缺省回显最后一条用户消息
 * @param {(hit: object, index: number) => ({ text?: string, toolCalls?: Array<{ name: string, args?: unknown }> } | undefined)} [opts.plan]
 *        按「第几次请求」脚本化回复 —— 多步工具循环靠它（第 1 次发 script_spec、第 2 次发 script_apply…）
 * @param {string} [opts.model] 回包里的 model 字段（默认 stub-model）
 * @param {number} [opts.holdAfterFirstChunkMs] **首片文本之后**的延时：制造「吐了半截还没完」的窗口（验中止落盘）
 * @param {number} [opts.delayMs] 响应前的延时：把「生成中」的窗口拉长（别越过 offscreen 的流式静默守卫，默认 60s）
 * @param {number} [opts.port] 监听端口；缺省 0（随机）
 */
export async function startModelStub(opts = {}) {
  const modelId = opts.model ?? 'stub-model'
  const hits = []
  const replyText = (lastUser) =>
    opts.reply ? opts.reply(lastUser, hits[hits.length - 1]) : `stub 回复：${lastUser}`

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      let body = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        /* 空体按空对象处理：仍然回一句，避免调用方干等 */
      }
      const messages = body.messages ?? []
      const lastUserRaw = [...messages].reverse().find((m) => m.role === 'user')?.content
      const hit = {
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
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
        return
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...CORS })
      const chunk = (delta, finish) =>
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
        res.write(usageFrame)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      // 流式文本：分两片吐字 + finish + [DONE]（AI SDK 认这个形状）
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

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve(server.address().port))
  })
  return {
    // 完整端点地址：链路侧原样请求，所以这里必须带上 /chat/completions（不再由调用方拼）
    stub: { baseUrl: `http://127.0.0.1:${port}/chat/completions`, port, hits },
    server,
    replyText,
    setOptions: (patch) => Object.assign(opts, patch),
  }
}

// —— CLI：npm run model:serve / node scripts/model-stub.mjs ——
// 用途：不跑 dev 的手测（加载已构建的 .output 产物）也要有个假模型可接，与 `probe:serve` 对称。
const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isCli) {
  const argPort = process.argv.indexOf('--port')
  const port = Number(argPort >= 0 ? process.argv[argPort + 1] : process.env.DL_MODEL_STUB_PORT || DEFAULT_PORT)
  const model = await startModelStub({ port: Number.isFinite(port) ? port : DEFAULT_PORT })
  console.log(`[假模型] 已就绪：${model.stub.baseUrl}`)
  console.log('[假模型] 填进「设置 → 添加模型 → 服务商选自定义 → 接口地址」（密钥可留空）')
  console.log('[假模型] 保持本进程运行；Ctrl-C 结束')
  console.log('[假模型] 调试触发：消息整句发「快照」或「页面环境」，即可走通对应的工具链')
}
