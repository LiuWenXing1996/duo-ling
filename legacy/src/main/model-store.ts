// 在线模型配置存取与加密（electron-store + safeStorage）。
// 职责边界：只负责「新增/编辑/删除/启停/选中 + 加解密 + 读取当前生效配置」，
// 不涉及网络请求（openai-client）与 Agent 编排（agent-orchestrator）。

import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import Store, { type Schema } from 'electron-store'
import type { ModelProfile, ModelProfileInput } from '../shared/types'

export type { ModelProfile, ModelProfileInput }

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
  activeProfileId: { type: 'string' }
}

let store: Store<ModelStoreState> | undefined

// 惰性创建：首次调用发生在 IPC 处理时（app 就绪且 userData 覆盖已生效之后）
function getStore(): Store<ModelStoreState> {
  store ??= new Store<ModelStoreState>({
    name: 'model-profiles',
    defaults: {
      profiles: [],
      activeProfileId: ''
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

/** 内部完整配置（含解密后的 apiKey），仅 main 进程使用 */
export function getActiveConfig(): {
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
