import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteProfile,
  generateReply,
  generateReplyWithSystemPrompt,
  getActiveProfileId,
  getPublicProfiles,
  getSystemPrompt,
  isConfigured,
  listModels,
  saveProfile,
  setActiveProfile,
  setProfileEnabled,
  setSystemPrompt
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
  memory = { profiles: [], activeProfileId: '', systemPrompt: '' }
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

describe('全局系统提示词', () => {
  it('默认清空，set/get 往返并去除首尾空白', () => {
    expect(getSystemPrompt()).toBe('')
    setSystemPrompt('  请用中文回答  ')
    expect(getSystemPrompt()).toBe('请用中文回答')
    setSystemPrompt('')
    expect(getSystemPrompt()).toBe('')
  })
})

describe('generateReply（OpenAI 兼容流式）', () => {
  it('SSE 逐 token 回调并返回完整回复，请求使用默认模型配置', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: [DONE]\n\n'
      ])
    )
    const tokens: string[] = []
    const reply = await generateReply([], '你好', (t) => tokens.push(t), new AbortController().signal)

    expect(tokens).toEqual(['你', '好'])
    expect(reply).toBe('你好')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('deepseek-chat')
    expect(body.stream).toBe(true)
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: '你好' })
  })

  it('SSE 帧跨多个网络分块时也能正确拼接解析', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 第一帧被拆成两半，且两帧挤在同一个分块里
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"de'))
        controller.enqueue(encoder.encode('lta":{"content":"好"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    })
    fetchMock.mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    )
    const tokens: string[] = []
    const reply = await generateReply([], '你好', (t) => tokens.push(t), new AbortController().signal)
    expect(tokens).toEqual(['你', '好'])
    expect(reply).toBe('你好')
  })

  it('非 2xx 响应抛出带状态码的错误', async () => {
    fetchMock.mockResolvedValue(new Response('invalid key', { status: 401, statusText: 'Unauthorized' }))
    await expect(
      generateReply([], 'hi', () => {}, new AbortController().signal)
    ).rejects.toThrow('401')
  })

  it('服务商返回非流式 JSON 时降级为一次性读取', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '全文' } }] }), {
        headers: { 'content-type': 'application/json' }
      })
    )
    const tokens: string[] = []
    const reply = await generateReply([], 'hi', (t) => tokens.push(t), new AbortController().signal)
    expect(tokens).toEqual(['全文'])
    expect(reply).toBe('全文')
  })

  it('透传 AbortSignal 给 fetch', async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: [DONE]\n\n']))
    const controller = new AbortController()
    await generateReply([], 'hi', () => {}, controller.signal)
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.signal).toBe(controller.signal)
  })

  it('配置全局系统提示词时发送 system 消息；清空后不发送', async () => {
    setSystemPrompt('  你是 Duo Ling 的助手  ')
    fetchMock.mockResolvedValue(sseResponse(['data: [DONE]\n\n']))
    await generateReply([], 'hi', () => {}, new AbortController().signal)
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)
    expect(body.messages[0]).toEqual({ role: 'system', content: '你是 Duo Ling 的助手' })

    // 清空系统提示词后不再发送 system 消息
    setSystemPrompt('')
    fetchMock.mockResolvedValue(sseResponse(['data: [DONE]\n\n']))
    await generateReply([], 'hi', () => {}, new AbortController().signal)
    const body2 = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string)
    expect(body2.messages.every((m: { role: string }) => m.role !== 'system')).toBe(true)
  })

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
    const reply = await generateReplyWithSystemPrompt(
      '',
      [],
      '你好',
      (t) => tokens.push(t),
      new AbortController().signal
    )

    // 思考与正文分离：onToken 只收正文 token，reasoning 单独返回，不再拼接 <think> 标签
    expect(tokens).toEqual(['结论'])
    expect(reply.content).toBe('结论')
    expect(reply.reasoning).toBe('先分析再推理')
  })

  it('推理模型：仅思考无正文时 reasoning 保留、正文为空', async () => {
    fetchMock.mockResolvedValue(
      sseResponse(['data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}\n\n', 'data: [DONE]\n\n'])
    )
    const tokens: string[] = []
    const reply = await generateReplyWithSystemPrompt(
      '',
      [],
      '你好',
      (t) => tokens.push(t),
      new AbortController().signal
    )

    expect(tokens).toEqual([])
    expect(reply.content).toBe('')
    expect(reply.reasoning).toBe('思考中')
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
