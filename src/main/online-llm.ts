import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import Store, { type Schema } from 'electron-store'
import type { ChatMessage } from './chat-store'
import type { ModelProfile, ModelProfileInput } from '../shared/types'

export type { ModelProfile, ModelProfileInput }

export const DEFAULT_SYSTEM_PROMPT = '你是 Duo Ling 的 AI 助手，请用中文回答。'

interface ModelProfileState {
  id: string
  name: string
  providerId: string
  baseUrl: string
  /** safeStorage 加密后的 apiKey（base64） */
  apiKeyEncrypted: string
  model: string
  enabled: boolean
  useFullUrl: boolean
  apiFormat: 'openai'
  contextOutputToken?: number
  temperature?: number
  topP?: number
  topK?: number
}

interface ModelStoreState {
  profiles: ModelProfileState[]
  activeProfileId: string
  /** 全局系统提示词：所有模型共用；为空则不发送 system 消息 */
  systemPrompt: string
}

const schema: Schema<ModelStoreState> = {
  profiles: {
    type: 'array',
    items: {
      type: 'object',
      required: ['id', 'name', 'baseUrl', 'apiKeyEncrypted', 'model'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        providerId: { type: 'string' },
        baseUrl: { type: 'string' },
        apiKeyEncrypted: { type: 'string' },
        model: { type: 'string' },
        enabled: { type: 'boolean' },
        useFullUrl: { type: 'boolean' },
        apiFormat: { type: 'string' },
        contextOutputToken: { type: 'number' },
        temperature: { type: 'number' },
        topP: { type: 'number' },
        topK: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  activeProfileId: { type: 'string' },
  systemPrompt: { type: 'string' }
}

let store: Store<ModelStoreState> | undefined

// 惰性创建：首次调用发生在 IPC 处理时（app 就绪且 userData 覆盖已生效之后）
function getStore(): Store<ModelStoreState> {
  store ??= new Store<ModelStoreState>({
    name: 'model-profiles',
    defaults: {
      profiles: [],
      activeProfileId: '',
      systemPrompt: DEFAULT_SYSTEM_PROMPT
    },
    schema
  })
  return store
}

function encryptApiKey(key: string): string {
  if (!key) return ''
  // macOS 走 Keychain、Windows 走 DPAPI；极少数环境不可用时退化为明文存储
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(key).toString('base64')
  }
  return key
}

function decryptApiKey(encrypted: string): string {
  if (!encrypted) return ''
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      return ''
    }
  }
  return encrypted
}

function toPublic(profile: ModelProfileState): ModelProfile {
  return {
    id: profile.id,
    name: profile.name || profile.model,
    providerId: profile.providerId,
    baseUrl: profile.baseUrl,
    model: profile.model,
    enabled: profile.enabled ?? true,
    useFullUrl: profile.useFullUrl ?? false,
    apiFormat: profile.apiFormat ?? 'openai',
    hasApiKey: Boolean(profile.apiKeyEncrypted),
    contextOutputToken: profile.contextOutputToken,
    temperature: profile.temperature,
    topP: profile.topP,
    topK: profile.topK
  }
}

/** 全部模型配置（不含明文 apiKey） */
export function getPublicProfiles(): ModelProfile[] {
  return getStore().store.profiles.map(toPublic)
}

/** 当前生效的配置：activeProfileId 指向的已启用模型；不存在则无。
 * 此处不做运行时兜底，回退统一由持久化层 syncActiveProfileId 保证，避免隐含状态。 */
function getActiveProfile(): ModelProfileState | undefined {
  const state = getStore().store
  return state.profiles.find((p) => p.id === state.activeProfileId && p.enabled !== false)
}

/** 当前真正生效的激活模型 id：始终指向一条启用的配置（无则空串）。
 * 与 getActiveProfile 同一来源，作为前端展示与后端发送的唯一真源。 */
export function getActiveProfileId(): string {
  return getActiveProfile()?.id ?? ''
}

/** 保证 activeProfileId 始终指向一条已启用的配置；没有启用配置时置空串。
 * 持久化层回退的唯一入口：任何 profiles 变更后调用，使 activeProfileId 始终有效。 */
function syncActiveProfileId(): void {
  const state = getStore().store
  const enabled = state.profiles.filter((p) => p.enabled !== false)
  if (!enabled.some((p) => p.id === state.activeProfileId)) {
    getStore().set('activeProfileId', enabled[0]?.id ?? '')
  }
}

/** 全局系统提示词：所有模型共用；为空则不发送 system 消息 */
export function getSystemPrompt(): string {
  return getStore().store.systemPrompt ?? ''
}

/** 设置全局系统提示词；传入空串表示清空（之后不再发送 system 消息） */
export function setSystemPrompt(value: string): void {
  getStore().set('systemPrompt', value.trim())
}

/** 内部完整配置（含解密后的 apiKey），仅 main 进程使用 */
function getActiveConfig(): {
  baseUrl: string
  apiKey: string
  model: string
  useFullUrl: boolean
  contextOutputToken?: number
  temperature?: number
  topP?: number
  topK?: number
} {
  const profile = getActiveProfile()
  return {
    baseUrl: profile?.baseUrl ?? '',
    apiKey: profile ? decryptApiKey(profile.apiKeyEncrypted) : '',
    model: profile?.model ?? '',
    useFullUrl: profile?.useFullUrl ?? false,
    contextOutputToken: profile?.contextOutputToken,
    temperature: profile?.temperature,
    topP: profile?.topP,
    topK: profile?.topK
  }
}

/**
 * 新增或更新模型配置。新增时若还没有默认模型，自动成为默认；
 * 编辑时 apiKey 为空保留原 Key。展示名为空时回退为模型 ID。
 */
export function saveProfile(input: ModelProfileInput): ModelProfile {
  const state = getStore().store
  const existing = input.id ? state.profiles.find((p) => p.id === input.id) : undefined
  const apiKey = input.apiKey.trim()
  const profile: ModelProfileState = {
    id: existing?.id ?? randomUUID(),
    name: input.name.trim() || input.model.trim() || '未命名模型',
    providerId: input.providerId ?? existing?.providerId ?? '',
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    apiKeyEncrypted: apiKey ? encryptApiKey(apiKey) : (existing?.apiKeyEncrypted ?? ''),
    model: input.model.trim(),
    enabled: input.enabled ?? existing?.enabled ?? true,
    useFullUrl: input.useFullUrl ?? existing?.useFullUrl ?? false,
    apiFormat: 'openai',
    contextOutputToken: input.contextOutputToken,
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK
  }

  if (existing) {
    getStore().set(
      'profiles',
      state.profiles.map((p) => (p.id === profile.id ? profile : p))
    )
  } else {
    getStore().set('profiles', [...state.profiles, profile])
    // 第一条配置自动成为默认模型
    if (!state.activeProfileId) getStore().set('activeProfileId', profile.id)
  }
  syncActiveProfileId()
  return toPublic(profile)
}

export function deleteProfile(id: string): void {
  const state = getStore().store
  getStore().set(
    'profiles',
    state.profiles.filter((p) => p.id !== id)
  )
  syncActiveProfileId()
}

export function setActiveProfile(id: string): void {
  const state = getStore().store
  if (!state.profiles.some((p) => p.id === id)) return
  getStore().set('activeProfileId', id)
}

/** 启用/禁用某个模型（开关）。禁用的模型不参与对话生成，但仍保留在列表中。 */
export function setProfileEnabled(id: string, enabled: boolean): void {
  const state = getStore().store
  if (!state.profiles.some((p) => p.id === id)) return
  getStore().set(
    'profiles',
    state.profiles.map((p) => (p.id === id ? { ...p, enabled } : p))
  )
  syncActiveProfileId()
}

/** 当前默认模型可用（baseUrl + apiKey + model 齐全） */
export function isConfigured(): boolean {
  const profile = getActiveProfile()
  return Boolean(profile && profile.baseUrl && profile.apiKeyEncrypted && profile.model)
}

/** 读取指定配置的解密 API Key（编辑态连通性测试用，Key 未回显时回退） */
export function getProfileApiKey(id: string): string {
  const profile = getStore().store.profiles.find((p) => p.id === id)
  return profile ? decryptApiKey(profile.apiKeyEncrypted) : ''
}

/**
 * 拉取服务商可用模型列表（GET /models），失败抛错由调用方包装。
 * overrides 提供时用其测试（不落盘），否则用当前默认模型配置。
 */
export async function listModels(overrides?: {
  baseUrl?: string
  apiKey?: string
}): Promise<string[]> {
  const saved = getActiveConfig()
  const baseUrl = (overrides?.baseUrl ?? saved.baseUrl).trim().replace(/\/+$/, '')
  const apiKey = overrides?.apiKey?.trim() || saved.apiKey
  if (!baseUrl) throw new Error('请先填写接口地址（baseUrl）')
  if (!apiKey) throw new Error('请先填写 API Key')

  const res = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!res.ok) {
    throw new Error(`获取模型列表失败（${res.status}）：${(await res.text()).slice(0, 200)}`)
  }
  const body = (await res.json()) as { data?: Array<{ id: string }> }
  return (body.data ?? []).map((m) => m.id).filter(Boolean)
}

/**
 * 连通性测试：用传入的配置发一次「最小」chat 请求（非流式），验证地址/Key/模型是否可用。
 * 会消耗极少量 Token，超时默认 15s。失败会抛错，由调用方包装为友好提示。
 */
export async function testChatConnection(config: {
  baseUrl: string
  apiKey?: string
  model: string
  useFullUrl?: boolean
}): Promise<void> {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '')
  const apiKey = config.apiKey?.trim() ?? ''
  const model = config.model.trim()
  if (!baseUrl) throw new Error('请先填写接口地址（baseUrl）')
  if (!apiKey) throw new Error('请先填写 API Key')
  if (!model) throw new Error('请先填写模型 ID')

  const url = config.useFullUrl ? baseUrl : `${baseUrl}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
        max_tokens: 8
      }),
      signal: controller.signal
    })
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300)
      throw new Error(`连接失败（${res.status}）：${text || res.statusText}`)
    }
    const body = (await res.json()) as { choices?: unknown[] }
    if (!body.choices?.length) {
      throw new Error('请求成功但未返回内容，请检查模型是否正确')
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('连通性测试超时，请检查网络或接口地址')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 流式生成回复（OpenAI 兼容 /chat/completions，SSE）。
 * token 逐段回调 onToken；signal 中止时 fetch 抛错，由上层按中止处理。
 * 使用全局系统提示词。
 */
export function generateReply(
  history: ChatMessage[],
  userText: string,
  onToken: (text: string) => void,
  signal: AbortSignal
): Promise<string> {
  return generateReplyWithSystemPrompt(getSystemPrompt(), history, userText, onToken, signal).then(
    (r) => r.content
  )
}

// —— Agent Loop ——
// 模型「思考 → 调用工具 → 拿结果 → 再思考 → … → 最终正文」的多轮循环。
// 底层仍是单次 OpenAI 兼容流式请求（streamOnce），由 generateAgentReply 编排多轮：
// 每轮若模型返回 tool_calls，则把结果以 role:'tool' 回传后再请求，直至模型给出最终 content。

/** OpenAI 兼容的 function 定义（tools 数组每一项） */
export type OpenAITool = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** 一次工具调用（SSE 按 index 累积后归一化） */
export interface AgentToolCall {
  id: string
  name: string
  arguments: string
}

/** 工具执行结果（模型以 role:'tool' 收到的是其 JSON 字符串） */
export interface AgentToolResult {
  ok: boolean
  result?: string
  error?: string
}

export interface GenerateAgentOptions {
  /** 可调用工具定义（buildAgentTools 产出），空数组则退化为单轮 */
  tools: OpenAITool[]
  /** 执行某能力/工具，产出的结果回传模型（异常统一收敛为 { ok:false }，不打断循环） */
  executeTool: (name: string, argsJson: string) => Promise<AgentToolResult>
  onToolStart?: (call: AgentToolCall) => void
  onToolResult?: (name: string, result: AgentToolResult) => void
  /** 推理模型思考过程增量：与正文分离推给调用方（对应 SSE 的 reasoning_content） */
  onReasoning?: (text: string) => void
  /** 最大循环轮数，默认 8 */
  maxRounds?: number
}

/** Agent Loop 编排器：多次 streamOnce，直到模型不再请求工具而给出最终正文 */
export async function generateAgentReply(
  systemPrompt: string,
  history: ChatMessage[],
  userText: string,
  onToken: (text: string) => void,
  signal: AbortSignal,
  opts: GenerateAgentOptions
): Promise<{ content: string; reasoning: string }> {
  if (!isConfigured()) {
    throw new Error('尚未配置可用的在线模型，请先在「设置」中添加')
  }
  const config = getActiveConfig()

  // 消息集会随着工具调用的往返不断增长；此处直接用一个可变数组承载
  const messages: Array<Record<string, unknown>> = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText }
  ]

  const maxRounds = opts.maxRounds ?? 8
  // 累积所有轮次的内容（含中间轮思考）：onToken.onReasoning 已即时推送给前端用于实时显示，
  // 此处把各轮拼接作为「最终完整回复」，避免中间轮思考在收尾覆盖时丢失。
  let accContent = ''
  let accReasoning = ''
  for (let round = 0; round <= maxRounds; round++) {
    const { content, reasoning, toolCalls } = await streamOnce(
      config,
      messages,
      opts.tools,
      onToken,
      opts.onReasoning,
      signal
    )
    accContent += content
    accReasoning += reasoning

    // 无工具调用 → 这是最终答案
    if (toolCalls.length === 0) {
      // 模型可能只输出了空内容（如对「你好呀」一类非工具请求无话可说），给一条兜底文案
      const body = accContent.trim() ? accContent : '（模型未返回任何内容，请重试或换个说法）'
      return { content: body, reasoning: accReasoning }
    }

    // 有工具调用：先把带 tool_calls 的 assistant 消息入列，再逐个执行并回传结果
    messages.push({
      role: 'assistant',
      content,
      tool_calls: toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments }
      }))
    })
    for (const call of toolCalls) {
      if (signal.aborted) throw new Error('生成已中止')
      opts.onToolStart?.(call)
      const result = await opts.executeTool(call.name, call.arguments)
      opts.onToolResult?.(call.name, result)
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: result.ok ? result.result ?? '' : (result.error ?? '')
      })
    }
  }

  throw new Error(`已达到最大工具调用轮数（${maxRounds}）`)
}

/**
 * 单轮 OpenAI 兼容流式请求（SSE）。
 * 返回 { content, reasoning, toolCalls }：content 为最终正文（不含思考），reasoning 为思考过程，
 * toolCalls 为模型请求调用的工具（可能为空）。思考与正文分离，onToken 只收正文、onReasoning 只收思考。
 * 兼容不传 tools 或服务商忽略 tools 的情况。
 */
async function streamOnce(
  config: ReturnType<typeof getActiveConfig>,
  messages: Array<Record<string, unknown>>,
  tools: OpenAITool[],
  onToken: (text: string) => void,
  onReasoning: ((text: string) => void) | undefined,
  signal: AbortSignal
): Promise<{ content: string; reasoning: string; toolCalls: AgentToolCall[] }> {
  const { baseUrl, apiKey, model, useFullUrl, contextOutputToken, temperature, topP, topK } = config

  // useFullUrl 时为完整接口地址，否则补充 /chat/completions
  const url = useFullUrl ? baseUrl : `${baseUrl}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      ...(contextOutputToken != null ? { max_tokens: contextOutputToken } : {}),
      ...(temperature != null ? { temperature } : {}),
      ...(topP != null ? { top_p: topP } : {}),
      ...(topK != null ? { top_k: topK } : {})
    }),
    signal
  })

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300)
    throw new Error(`模型请求失败（${res.status}）：${detail || res.statusText}`)
  }
  if (!res.body) {
    throw new Error('模型请求无响应内容')
  }

  const contentType = res.headers.get('content-type') ?? ''
  // 极少数服务商忽略 stream 选项返回完整 JSON：降级为一次性读取（含 tool_calls）
  if (!contentType.includes('text/event-stream')) {
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string; tool_calls?: Array<SerializedToolCall> } }>
    }
    const msg = body.choices?.[0]?.message
    const content = msg?.content ?? ''
    if (content) onToken(content)
    return {
      content,
      reasoning: msg?.reasoning_content ?? '',
      toolCalls: (msg?.tool_calls ?? []).map(mapSerializedToolCall)
    }
  }

  // 标准 SSE：data: {...} 逐帧，data: [DONE] 结束
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let contentText = ''
  let reasoningText = ''
  // OpenAI 会把 tool_calls 按 index 分帧拆发 function.name / function.arguments，此处按 index 累积
  const toolCallAcc = new Map<number, { id: string; name: string; arguments: string }>()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const data = parseSseData(frame)
      if (data === null) continue
      if (data === '[DONE]') {
        return { content: contentText, reasoning: reasoningText, toolCalls: Array.from(toolCallAcc.values()) }
      }
      try {
        const json = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string
              reasoning_content?: string
              tool_calls?: Array<{
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
          }>
        }
        const delta = json.choices?.[0]?.delta

        for (const tc of delta?.tool_calls ?? []) {
          const slot = toolCallAcc.get(tc.index) ?? { id: '', name: '', arguments: '' }
          if (tc.id) slot.id += tc.id
          if (tc.function?.name) slot.name += tc.function.name
          if (tc.function?.arguments) slot.arguments += tc.function.arguments
          toolCallAcc.set(tc.index, slot)
        }

        const reasoning = delta?.reasoning_content
        if (reasoning) {
          reasoningText += reasoning
          onReasoning?.(reasoning)
        }
        const content = delta?.content
        if (content) {
          contentText += content
          onToken(content)
        }
      } catch {
        // 忽略畸形帧，避免个别服务商混入的注释行中断流程
      }
    }
  }
  return { content: contentText, reasoning: reasoningText, toolCalls: Array.from(toolCallAcc.values()) }
}

/** 非流式一次性请求里 message.tool_calls 的形状 */
interface SerializedToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

function mapSerializedToolCall(c: SerializedToolCall): AgentToolCall {
  return {
    id: c.id ?? '',
    name: c.function?.name ?? '',
    arguments: c.function?.arguments ?? ''
  }
}

/**
 * 流式生成回复，允许外部指定系统提示词（普通对话用全局提示词；生成器用能力清单提示词）。
 * 不传 tools，行为等同旧版单轮生成。如需 Agent Loop，请改用 generateAgentReply。
 */
export async function generateReplyWithSystemPrompt(
  systemPrompt: string,
  history: ChatMessage[],
  userText: string,
  onToken: (text: string) => void,
  signal: AbortSignal
): Promise<{ content: string; reasoning: string }> {
  if (!isConfigured()) {
    throw new Error('尚未配置可用的在线模型，请先在「设置」中添加')
  }
  const { content, reasoning } = await streamOnce(getActiveConfig(), [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText }
  ], [], onToken, undefined, signal)
  return { content, reasoning }
}

/** 从单个 SSE frame 中提取 data: 行的内容；无 data 行返回 null */
function parseSseData(frame: string): string | null {
  const lines = frame.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice('data:'.length).trim()
    return data
  }
  return null
}
