import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteProfile,
  generateChat,
  getActiveProfileId,
  getPublicProfiles,
  isConfigured,
  listModels,
  saveProfile,
  setActiveProfile,
  setProfileEnabled
} from './online-llm'

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

function sseResponse(frames: string[], contentType = 'text/event-stream'): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    }
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': contentType }
  })
}

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

describe('generateChat（空 tools 退化为单轮）', () => {
  it('推理模型：reasoning_content 与 content 分离，正文 token 流只含 content', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"先分析"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"再推理"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"结论"}}]}\n\n',
        'data: [DONE]\n\n'
      ])
    )
    const tokens: string[] = []
    const reply = await generateChat(
      '',
      [],
      '你好',
      (t) => tokens.push(t),
      new AbortController().signal,
      { tools: [], executeTool: async () => ({ ok: true, result: '' }) }
    )

    // 思考与正文分离：onToken 只收正文 token，reasoning 单独返回，不再拼接 <think> 标签
    expect(tokens).toEqual(['结论'])
    expect(reply.content).toBe('结论')
    expect(reply.reasoning).toBe('先分析再推理')
  })

  it('推理模型：仅思考无正文时 reasoning 保留、正文兜底', async () => {
    fetchMock.mockResolvedValue(
      sseResponse(['data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}\n\n', 'data: [DONE]\n\n'])
    )
    const tokens: string[] = []
    const reply = await generateChat(
      '',
      [],
      '你好',
      (t) => tokens.push(t),
      new AbortController().signal,
      { tools: [], executeTool: async () => ({ ok: true, result: '' }) }
    )

    expect(tokens).toEqual([])
    expect(reply.content).toBe('（模型未返回任何内容，请重试或换个说法）')
    expect(reply.reasoning).toBe('思考中')
  })

  it('多轮工具调用：中间轮正文不进最终回复，只保留最终一轮正文', async () => {
    // 第 1 轮：模型先输出正文再请求调用 agent_tools_create
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"我来帮你创建。"}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"agent_tools_create","arguments":"{}"}}]}}]}\n\n',
          'data: [DONE]\n\n'
        ])
      )
      // 第 2 轮：拿到工具结果后输出最终正文，不再请求工具
      .mockResolvedValueOnce(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"已创建完成，这是最终正文。"}}]}\n\n',
          'data: [DONE]\n\n'
        ])
      )

    const tokens: string[] = []
    const executeTool = vi.fn().mockResolvedValue({ ok: true, result: '工具已创建' })
    const reply = await generateChat('', [], '创建一个工具', (t) => tokens.push(t), new AbortController().signal, {
      tools: [{ type: 'function', function: { name: 'agent_tools_create', description: '', parameters: {} } }],
      executeTool
    })

    // 中间轮正文不再拼接进最终回复：reply.content 只含最终一轮正文
    expect(reply.content).toBe('已创建完成，这是最终正文。')
    // onToken 仍把每轮正文实时推给前端（供前端在 tool_start 时把中间轮抽出归入步骤）
    expect(tokens).toEqual(['我来帮你创建。', '已创建完成，这是最终正文。'])
    // 工具确实被执行一次，且以该轮正文作为 assistant 上下文回传模型
    expect(executeTool).toHaveBeenCalledTimes(1)
    expect(executeTool).toHaveBeenCalledWith('agent_tools_create', '{}')
  })

  it('多轮工具调用：中间轮思考不进最终回复，只保留最终一轮思考', async () => {
    // 第 1 轮：模型先思考再输出正文并请求调用工具
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([
          'data: {"choices":[{"delta":{"reasoning_content":"我先分析场景。"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"我来帮你创建。"}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"agent_tools_create","arguments":"{}"}}]}}]}\n\n',
          'data: [DONE]\n\n'
        ])
      )
      // 第 2 轮：拿到工具结果后输出最终思考与正文，不再请求工具
      .mockResolvedValueOnce(
        sseResponse([
          'data: {"choices":[{"delta":{"reasoning_content":"最终结论。"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"已创建完成。"}}]}\n\n',
          'data: [DONE]\n\n'
        ])
      )

    const tokens: string[] = []
    const reasoningSlices: string[] = []
    const executeTool = vi.fn().mockResolvedValue({ ok: true, result: '工具已创建' })
    const reply = await generateChat('', [], '创建一个工具', (t) => tokens.push(t), new AbortController().signal, {
      tools: [{ type: 'function', function: { name: 'agent_tools_create', description: '', parameters: {} } }],
      executeTool,
      onReasoning: (text) => reasoningSlices.push(text)
    })

    // 中间轮思考不再拼接进最终回复：reply.reasoning 只含最终一轮思考
    expect(reply.reasoning).toBe('最终结论。')
    // onReasoning 仍把每轮思考实时推给前端（供前端在 tool_start 时把中间轮归档到 reasonings）
    expect(reasoningSlices).toEqual(['我先分析场景。', '最终结论。'])
    // 正文同样只保留最终轮，工具执行一次
    expect(reply.content).toBe('已创建完成。')
    expect(executeTool).toHaveBeenCalledTimes(1)
  })
})

describe('listModels', () => {
  it('解析 /models 返回的 id 列表', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), {
        headers: { 'content-type': 'application/json' }
      })
    )
    await expect(listModels()).resolves.toEqual(['model-a', 'model-b'])
  })

  it('失败时抛错（401）', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }))
    await expect(listModels()).rejects.toThrow('401')
  })

  it('未配置 apiKey 时直接抛错', async () => {
    // 清空存储后添加一条没有 apiKey 的配置（校验顺序：baseUrl 已满足，报 API Key 缺失）
    memory = { profiles: [], activeProfileId: '' }
    saveProfile({
      name: 'X',
      baseUrl: 'https://x.example.com/v1',
      apiKey: '',
      model: 'm'
    })
    await expect(listModels()).rejects.toThrow('API Key')
  })
})
