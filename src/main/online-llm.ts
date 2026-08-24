import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import Store, { type Schema } from 'electron-store'
import type { ChatMessage } from './chat-store'

/** 渲染进程可见的模型配置（apiKey 不回传明文，只暴露是否已设置） */
export interface ModelProfile {
  id: string
  /** 模型展示名，如 DeepSeek-V3；未设置时回退为模型 ID */
  name: string
  /** 所属服务商（预设 id），自定义模型为空字符串 */
  providerId: string
  /** OpenAI 兼容接口地址，如 https://api.deepseek.com/v1 */
  baseUrl: string
  /** 模型 ID，如 deepseek-chat（请求时作为 model 字段） */
  model: string
  /** 是否已在模型列表中启用（开关） */
  enabled: boolean
  /** baseUrl 是否为完整接口地址：true 时不追加 /chat/completions */
  useFullUrl: boolean
  /** API 格式，目前仅支持 OpenAI Chat Completions */
  apiFormat: 'openai'
  hasApiKey: boolean
  /** 上下文输出 Token（高级配置，作为请求 max_tokens） */
  contextOutputToken?: number
  /** 采样参数：Temperature（0~2） */
  temperature?: number
  /** 采样参数：Top P（0~1） */
  topP?: number
  /** 采样参数：Top K（1~100） */
  topK?: number
}

/** 保存/新增模型配置的入参；apiKey 为空表示保留已有 Key（编辑时未重输） */
export interface ModelProfileInput {
  id?: string
  name: string
  providerId?: string
  baseUrl: string
  apiKey: string
  model: string
  enabled?: boolean
  useFullUrl?: boolean
  contextOutputToken?: number
  temperature?: number
  topP?: number
  topK?: number
}

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
export const DEFAULT_SYSTEM_PROMPT = '你是 Duo Ling 的 AI 助手，请用中文回答。'

/** 生成器审批模式：manual（AI 产出变更清单后由用户确认再应用）或 auto（直接应用） */
export type GeneratorApprovalMode = 'manual' | 'auto'
export const DEFAULT_APPROVAL_MODE: GeneratorApprovalMode = 'manual'

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
  /** 生成器审批模式全局默认（manual / auto） */
  generatorApprovalMode: GeneratorApprovalMode
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
  systemPrompt: { type: 'string' },
  generatorApprovalMode: { type: 'string', enum: ['manual', 'auto'] }
}

let store: Store<ModelStoreState> | undefined

// 惰性创建：首次调用发生在 IPC 处理时（app 就绪且 userData 覆盖已生效之后）
function getStore(): Store<ModelStoreState> {
  store ??= new Store<ModelStoreState>({
    name: 'model-profiles',
    defaults: {
      profiles: [],
      activeProfileId: '',
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      generatorApprovalMode: DEFAULT_APPROVAL_MODE
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

/** 当前生成器审批模式的全局默认（manual / auto）；非法值回退为 manual */
export function getGeneratorApprovalMode(): GeneratorApprovalMode {
  return getStore().store.generatorApprovalMode === 'auto' ? 'auto' : 'manual'
}

/** 设置生成器审批模式的全局默认 */
export function setGeneratorApprovalMode(mode: GeneratorApprovalMode): void {
  getStore().set('generatorApprovalMode', mode === 'auto' ? 'auto' : 'manual')
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
  return generateReplyWithSystemPrompt(getSystemPrompt(), history, userText, onToken, signal)
}

/**
 * 流式生成回复，允许外部指定系统提示词（普通对话用全局提示词；生成器用能力清单提示词）。
 * 其余逻辑与 generateReply 一致。
 */
export async function generateReplyWithSystemPrompt(
  systemPrompt: string,
  history: ChatMessage[],
  userText: string,
  onToken: (text: string) => void,
  signal: AbortSignal
): Promise<string> {
  const {
    baseUrl,
    apiKey,
    model,
    useFullUrl,
    contextOutputToken,
    temperature,
    topP,
    topK
  } = getActiveConfig()
  if (!isConfigured()) {
    throw new Error('尚未配置可用的在线模型，请先在「设置」中添加')
  }

  const messages: Array<{ role: string; content: string }> = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText }
  ]

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
  // 极少数服务商忽略 stream 选项返回完整 JSON：降级为一次性读取
  if (!contentType.includes('text/event-stream')) {
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = body.choices?.[0]?.message?.content ?? ''
    if (content) onToken(content)
    return content
  }

  // 标准 SSE：data: {...} 逐帧，data: [DONE] 结束
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  // 推理模型（如 DeepSeek-R1）先流式输出 reasoning_content 思考过程，正文 content 延迟到达。
  // 把思考过程用 <think>...</think> 包裹后作为内容推送给前端，渲染层据此拆分展示。
  let thinkingOpen = false
  let thinkingClosed = false

  const push = (text: string): void => {
    if (text) {
      full += text
      onToken(text)
    }
  }
  const closeThinking = (): void => {
    if (thinkingOpen && !thinkingClosed) {
      push('</think>')
      thinkingClosed = true
    }
  }

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
        closeThinking()
        return full
      }
      try {
        const json = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>
        }
        const delta = json.choices?.[0]?.delta
        const reasoning = delta?.reasoning_content
        if (reasoning) {
          // 思考过程：仅在首个 token 前写入 <think> 开标签
          if (!thinkingOpen) push('<think>')
          thinkingOpen = true
          push(reasoning)
        }
        const content = delta?.content
        if (content) {
          // 从思考切换到正文：先闭合 <think>，再输出正文
          closeThinking()
          push(content)
        }
      } catch {
        // 忽略畸形帧，避免个别服务商混入的注释行中断流程
      }
    }
  }
  closeThinking()
  return full
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
