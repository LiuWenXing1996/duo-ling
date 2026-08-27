import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteProfile,
  getActiveProfileId,
  getPublicProfiles,
  isConfigured,
  saveProfile,
  setActiveProfile,
  setProfileEnabled
} from './model-store'

// electron 与 electron-store 均 mock：safeStorage 用明文编解码，store 用内存对象
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

let memory: Record<string, unknown> = {}

vi.mock('electron-store', () => {
  class MockStore {
    constructor(options: { defaults?: Record<string, unknown> }) {
      memory = { ...(options.defaults ?? {}) }
    }
    get store() {
      return memory
    }
    set(key: string, value: unknown) {
      memory[key] = value
    }
    get(key: string) {
      return memory[key]
    }
  }
  return { __esModule: true, default: MockStore }
})

const fetchMock = vi.fn()

/** 创建一条默认模型配置（第一条自动成为默认） */
function seedProfile(): void {
  saveProfile({
    name: 'DeepSeek',
    baseUrl: 'https://api.example.com/v1/',
    apiKey: 'sk-test',
    model: 'deepseek-chat'
  })
}

beforeEach(() => {
  // 与 electron-store 默认值保持一致，避免缓存实例读到的字段为 undefined
  memory = { profiles: [], activeProfileId: '' }
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  seedProfile()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('模型配置列表', () => {
  it('新增配置：第一条自动成为默认，baseUrl 去尾部斜杠，名称空时兜底', () => {
    const pub = getPublicProfiles()[0]
    expect(pub.name).toBe('DeepSeek')
    expect(pub.baseUrl).toBe('https://api.example.com/v1')
    expect(pub.hasApiKey).toBe(true)
    expect(getActiveProfileId()).toBe(pub.id)
    expect('apiKey' in pub).toBe(false)
  })

  it('新增第二条不改变默认配置', () => {
    const first = getPublicProfiles()[0]
    saveProfile({
      name: ' 通义 ',
      baseUrl: 'https://dashscope.example.com/v1',
      apiKey: 'sk-2',
      model: 'qwen-plus'
    })
    const profiles = getPublicProfiles()
    expect(profiles).toHaveLength(2)
    // name 两端去空格
    expect(profiles[1].name).toBe('通义')
    expect(getActiveProfileId()).toBe(first.id)
  })

  it('编辑已有配置：id 不变、数量不变，apiKey 为空保留原 Key', () => {
    const first = getPublicProfiles()[0]
    saveProfile({
      id: first.id,
      name: 'DeepSeek-V3',
      baseUrl: 'https://api.example.com/v1',
      apiKey: '',
      model: 'deepseek-v3'
    })
    const profiles = getPublicProfiles()
    expect(profiles).toHaveLength(1)
    expect(profiles[0].name).toBe('DeepSeek-V3')
    expect(profiles[0].hasApiKey).toBe(true)
  })

  it('编辑时填入新 apiKey 会更新', () => {
    const first = getPublicProfiles()[0]
    saveProfile({
      id: first.id,
      name: 'DeepSeek',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-new',
      model: 'deepseek-chat'
    })
    expect(getPublicProfiles()[0].hasApiKey).toBe(true)
  })

  it('setActiveProfile 切换默认；无效 id 忽略', () => {
    const [first, second] = [
      getPublicProfiles()[0],
      saveProfile({
        name: 'Qwen',
        baseUrl: 'https://dashscope.example.com/v1',
        apiKey: 'sk-2',
        model: 'qwen-plus'
      })
    ]
    setActiveProfile(second.id)
    expect(getActiveProfileId()).toBe(second.id)
    setActiveProfile('not-exist')
    expect(getActiveProfileId()).toBe(second.id)
    expect(first.id).not.toBe(second.id)
  })

  it('deleteProfile 删除默认时回退到剩余第一条', () => {
    const first = getPublicProfiles()[0]
    const second = saveProfile({
      name: 'Qwen',
      baseUrl: 'https://dashscope.example.com/v1',
      apiKey: 'sk-2',
      model: 'qwen-plus'
    })
    setActiveProfile(first.id)
    deleteProfile(first.id)
    expect(getPublicProfiles()).toHaveLength(1)
    expect(getActiveProfileId()).toBe(second.id)
  })

  it('isConfigured 依赖默认模型的 baseUrl/apiKey/model 齐全', () => {
    expect(isConfigured()).toBe(true)
    deleteProfile(getActiveProfileId())
    expect(isConfigured()).toBe(false)
  })

  it('禁用当前激活模型时回退到剩余第一条启用的模型', () => {
    const first = getActiveProfileId()
    const second = saveProfile({
      name: 'Qwen',
      baseUrl: 'https://dashscope.example.com/v1',
      apiKey: 'sk-2',
      model: 'qwen-plus'
    })
    setActiveProfile(first)
    expect(getActiveProfileId()).toBe(first)
    setProfileEnabled(first, false)
    expect(getActiveProfileId()).toBe(second.id)
    // 禁用的是激活模型本身，其余模型保持启用
    expect(getPublicProfiles().find((p) => p.id === first)?.enabled).toBe(false)
  })
})
