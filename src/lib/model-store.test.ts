// model-store.ts 单测：模型配置（IndexedDB duoling-app 库的 kv 键 modelProfiles）的读写语义。
//
// 这个模块把几条**不在类型里**的规则藏在存储层，靠这里兜：
//   · 展示名为空时回退模型 ID（ChatPanel 的 chip 与下拉只读 name、不做回退，
//     漏了这一步会渲染出空白项）；
//   · activeProfileId 始终指向一条存在的配置，唯一收敛点是 syncActiveProfileId；
//   · 读路径对**悬空**的 activeProfileId 自愈回写一次，此后不再事后兜底；
//   · apiKey 不落明文：写盘只有密文载荷，明文只经 getActiveProfileState 过界；
//   · 编辑时 apiKey 留空 = 保留原 Key（不是清空）；
//   · baseUrl 即**完整端点地址**，原样存（不再拼接路径，也就没有末尾斜杠剥离）；
//   · 老数据存的是「基址」，读取时一次性迁移为完整端点地址（见 migrateEndpointBaseUrls）。
//
// 手法：fake-indexeddb 提供全局 indexedDB；真跑 key-cipher 的 AES-GCM 往返，
// 因此能直接断言「落盘里搜不到明文」。整体 mock 掉 data-broadcast，并把
// chrome.runtime.sendMessage 换成哨兵，用于断言哪些操作会发通知。
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfileInput } from '@/shared/types'
import * as appDb from './app-db'
import { broadcastDataChange } from '@duoling/shared'
import {
  getActiveProfileId,
  getActiveProfileState,
  getProfileApiKey,
  listProfiles,
  removeProfile,
  saveProfile,
  setActiveProfile,
  testChat,
} from './model-store'

// mock 落在包根：shared 是单包，spread 保其余符号真身
vi.mock('@duoling/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@duoling/shared')>()),
  broadcastDataChange: vi.fn(),
}))

const broadcast = vi.mocked(broadcastDataChange)
const sendMessage = vi.fn((): Promise<void> => Promise.resolve())

/** 落盘键名（模块内私有常量，这里硬编码以锁住存储契约） */
const KEY = 'modelProfiles'

function input(overrides: Partial<ModelProfileInput> = {}): ModelProfileInput {
  return {
    name: '模型 A',
    baseUrl: 'https://api.example.com',
    apiKey: '',
    model: 'm-a',
    ...overrides,
  }
}

/** 直接写库：造老数据 / 悬空状态，绕过 saveProfile 的规范化。
 *  刻意保留 useFullUrl —— 那是老数据的真实形态（字段已删），顺带验迁移会把它清掉。 */
function rawProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1',
    name: '模型 A',
    providerId: '',
    // 老数据的 baseUrl 是基址（不带 /chat/completions），正是迁移的输入
    baseUrl: 'https://api.example.com',
    model: 'm-a',
    useFullUrl: false,
    apiFormat: 'openai',
    hasApiKey: false,
    ...overrides,
  }
}

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

const okResponse = (): Response => new Response(null, { status: 200 })

beforeEach(async () => {
  await appDb.clearAllForTests()
  broadcast.mockClear()
  sendMessage.mockClear()
  sendMessage.mockImplementation(() => Promise.resolve())
  vi.stubGlobal('chrome', { runtime: { sendMessage } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('展示名回退', () => {
  it('name 为空白时回退为模型 ID', async () => {
    const p = await saveProfile(input({ name: '   ', model: 'gpt-x' }))

    expect(p.name).toBe('gpt-x')
  })

  it('name 与 model 都为空时给占位名', async () => {
    const p = await saveProfile(input({ name: '  ', model: '   ' }))

    expect(p.name).toBe('未命名模型')
  })

  it('库里 name 为空的老数据：读取时同样按模型 ID 回退', async () => {
    await appDb.set(KEY, { profiles: [rawProfile({ name: '', model: 'gpt-x' })], activeProfileId: 'p1' })

    expect((await listProfiles())[0].name).toBe('gpt-x')
  })
})

describe('默认模型（activeProfileId 收敛）', () => {
  it('第一条配置自动成为默认', async () => {
    const a = await saveProfile(input({ name: 'A', model: 'ma' }))

    expect(await getActiveProfileId()).toBe(a.id)
  })

  it('再加一条不抢默认', async () => {
    const a = await saveProfile(input({ name: 'A', model: 'ma' }))
    await saveProfile(input({ name: 'B', model: 'mb' }))

    expect(await getActiveProfileId()).toBe(a.id)
  })

  it('setActiveProfile：切到存在的配置', async () => {
    await saveProfile(input({ name: 'A', model: 'ma' }))
    const b = await saveProfile(input({ name: 'B', model: 'mb' }))

    await setActiveProfile(b.id)

    expect(await getActiveProfileId()).toBe(b.id)
  })

  it('setActiveProfile：id 不存在则整个忽略（不写、不通知）', async () => {
    const a = await saveProfile(input({ name: 'A', model: 'ma' }))
    broadcast.mockClear()
    sendMessage.mockClear()

    await setActiveProfile('ghost')

    expect(await getActiveProfileId()).toBe(a.id)
    expect(broadcast).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('删掉当前默认：收敛到剩余第一条', async () => {
    const a = await saveProfile(input({ name: 'A', model: 'ma' }))
    const b = await saveProfile(input({ name: 'B', model: 'mb' }))

    await removeProfile(a.id)

    expect(await getActiveProfileId()).toBe(b.id)
  })

  it('删掉非默认配置：默认不动', async () => {
    const a = await saveProfile(input({ name: 'A', model: 'ma' }))
    const b = await saveProfile(input({ name: 'B', model: 'mb' }))

    await removeProfile(b.id)

    expect(await getActiveProfileId()).toBe(a.id)
  })

  it('删光：默认置空串', async () => {
    const a = await saveProfile(input({ name: 'A', model: 'ma' }))

    await removeProfile(a.id)

    expect(await getActiveProfileId()).toBe('')
  })
})

describe('读路径自愈：悬空的 activeProfileId', () => {
  it('读出时收敛回第一条，并把修正结果回写落盘', async () => {
    await appDb.set(KEY, { profiles: [rawProfile({ id: 'p1' })], activeProfileId: 'ghost' })

    expect(await getActiveProfileId()).toBe('p1')
    expect((await appDb.get<{ activeProfileId: string }>(KEY))?.activeProfileId).toBe('p1')
  })

  it('一条配置都没有时收敛成空串', async () => {
    await appDb.set(KEY, { profiles: [], activeProfileId: 'ghost' })

    expect(await getActiveProfileId()).toBe('')
  })
})

describe('一次性迁移：基址 → 完整端点地址', () => {
  it('老数据的基址被补上 /chat/completions，且落盘', async () => {
    await appDb.set(KEY, {
      profiles: [rawProfile({ baseUrl: 'https://api.deepseek.com' })],
      activeProfileId: 'p1',
    })

    expect((await listProfiles())[0].baseUrl).toBe('https://api.deepseek.com/chat/completions')
    const stored = await appDb.get<{ profiles: Array<Record<string, unknown>> }>(KEY)
    expect(stored?.profiles[0].baseUrl).toBe('https://api.deepseek.com/chat/completions')
  })

  it('已带后缀的地址不被重复追加（迁移幂等）', async () => {
    await appDb.set(KEY, {
      profiles: [rawProfile({ baseUrl: 'https://api.deepseek.com/v1/chat/completions' })],
      activeProfileId: 'p1',
    })

    expect((await listProfiles())[0].baseUrl).toBe('https://api.deepseek.com/v1/chat/completions')
  })

  it('迁移只跑一次：此后新增的地址不再被改写', async () => {
    await appDb.set(KEY, {
      profiles: [rawProfile({ baseUrl: 'http://127.0.0.1:5199/chat/completions' })],
      activeProfileId: 'p1',
    })
    await listProfiles() // 触发迁移，标记位落盘

    // 自定义端点的路径不以 /chat/completions 结尾，不该被补后缀
    await saveProfile(input({ baseUrl: 'https://gateway.example.com/api/llm' }))

    expect((await listProfiles())[1].baseUrl).toBe('https://gateway.example.com/api/llm')
  })

  it('顺带清掉已删字段 useFullUrl 的落盘残留', async () => {
    await appDb.set(KEY, {
      profiles: [rawProfile({ baseUrl: 'https://api.deepseek.com' })],
      activeProfileId: 'p1',
    })

    await listProfiles()

    const stored = await appDb.get<{ profiles: Array<Record<string, unknown>> }>(KEY)
    expect(stored?.profiles[0]).not.toHaveProperty('useFullUrl')
  })

  it('迁移标记落盘后不再反复回写', async () => {
    await listProfiles() // 空库：首次读也要落一次标记
    broadcast.mockClear()

    await listProfiles()

    expect(broadcast).not.toHaveBeenCalled()
  })
})

describe('apiKey：落盘密文、读回明文', () => {
  it('新增：落盘只有密文载荷，没有明文 key', async () => {
    await saveProfile(input({ apiKey: 'sk-secret' }))

    const stored = await appDb.get<{ profiles: Array<Record<string, unknown>> }>(KEY)
    const record = stored?.profiles[0] ?? {}

    expect(record.apiKey).toBeUndefined()
    expect(typeof (record.apiKeyEnc as { ct?: unknown })?.ct).toBe('string')
    expect(JSON.stringify(stored)).not.toContain('sk-secret')
  })

  it('listProfiles 不回传明文，只给 hasApiKey', async () => {
    await saveProfile(input({ apiKey: 'sk-secret' }))

    const [p] = await listProfiles()

    expect(p.hasApiKey).toBe(true)
    expect('apiKey' in p).toBe(false)
  })

  it('密文能解回原值（getProfileApiKey / getActiveProfileState）', async () => {
    const p = await saveProfile(input({ apiKey: 'sk-secret' }))

    expect(await getProfileApiKey(p.id)).toBe('sk-secret')
    expect((await getActiveProfileState())?.apiKey).toBe('sk-secret')
  })

  it('apiKey 前后空白在落盘前被 trim', async () => {
    const p = await saveProfile(input({ apiKey: '  sk-secret  ' }))

    expect(await getProfileApiKey(p.id)).toBe('sk-secret')
  })

  it('编辑时 apiKey 留空 = 保留原 Key（不是清空）', async () => {
    const p = await saveProfile(input({ apiKey: 'sk-secret' }))

    const updated = await saveProfile(input({ id: p.id, apiKey: '   ', name: '改个名' }))

    expect(updated.hasApiKey).toBe(true)
    expect(await getProfileApiKey(p.id)).toBe('sk-secret')
  })

  it('新增且 apiKey 为空：hasApiKey 为 false', async () => {
    const p = await saveProfile(input({ apiKey: '' }))

    expect(p.hasApiKey).toBe(false)
  })

  it('查不存在的配置：返回空串而非抛错', async () => {
    await expect(getProfileApiKey('ghost')).resolves.toBe('')
  })
})

describe('入参规范化与继承', () => {
  it('baseUrl 原样保存：只去首尾空白，不动路径（末尾斜杠保留）', async () => {
    const p = await saveProfile(input({ baseUrl: '  https://api.example.com///  ' }))

    expect(p.baseUrl).toBe('https://api.example.com///')
  })

  it('name 与 model 前后空白被 trim', async () => {
    const p = await saveProfile(input({ name: '  名字  ', model: '  m1  ' }))

    expect(p.name).toBe('名字')
    expect(p.model).toBe('m1')
  })

  it('新增时 providerId 缺省为空串', async () => {
    const p = await saveProfile(input())

    expect(p.providerId).toBe('')
  })

  it('编辑时缺省的 providerId 继承已有配置', async () => {
    const p = await saveProfile(input({ providerId: 'deepseek' }))

    const updated = await saveProfile(input({ id: p.id, name: 'B' }))

    expect(updated.providerId).toBe('deepseek')
  })
})

describe('saveProfile 的 id 语义', () => {
  it('传入已有 id：原地更新，不新增', async () => {
    const p = await saveProfile(input({ name: 'A' }))

    await saveProfile(input({ id: p.id, name: 'B' }))

    const all = await listProfiles()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(p.id)
    expect(all[0].name).toBe('B')
  })

  it('传入不存在的 id：当作新增，另生成 id（不按传入值落库）', async () => {
    const p = await saveProfile(input({ id: 'ghost', name: 'A' }))

    expect(p.id).not.toBe('ghost')
    expect(await listProfiles()).toHaveLength(1)
  })
})

describe('写出口通知', () => {
  it('saveProfile：广播 model 域并推送 offscreen:configChanged', async () => {
    await saveProfile(input())

    expect(broadcast).toHaveBeenCalledWith('model')
    expect(sendMessage).toHaveBeenCalledWith({ kind: 'offscreen:configChanged' })
  })

  it('removeProfile：同样经写出口通知', async () => {
    const p = await saveProfile(input())
    broadcast.mockClear()
    sendMessage.mockClear()

    await removeProfile(p.id)

    expect(broadcast).toHaveBeenCalledWith('model')
    expect(sendMessage).toHaveBeenCalledWith({ kind: 'offscreen:configChanged' })
  })

  it('offscreen 不在场（sendMessage 被拒）不阻断写操作', async () => {
    sendMessage.mockImplementation(() => Promise.reject(new Error('no receiving end')))

    await expect(saveProfile(input({ name: 'A' }))).resolves.toMatchObject({ name: 'A' })
  })
})

describe('testChat（连通性测试）', () => {
  it('缺 baseUrl / model：就地抛错，且一个请求都不发', async () => {
    const fetchMock = stubFetch(() => Promise.resolve(okResponse()))

    await expect(testChat({ baseUrl: '  ', apiKey: 'k', model: 'm' })).rejects.toThrow(
      '请先填写接口地址',
    )
    await expect(testChat({ baseUrl: 'https://x', apiKey: 'k', model: ' ' })).rejects.toThrow(
      '请先填写模型 ID',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('地址原样使用：填什么请求什么，不做任何拼接', async () => {
    const fetchMock = stubFetch(() => Promise.resolve(okResponse()))

    await testChat({
      baseUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: ' k ',
      model: ' m ',
    })
    await testChat({ baseUrl: 'http://127.0.0.1:5199/chat/completions', apiKey: '', model: 'm' })

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions')
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:5199/chat/completions')
  })

  it('apiKey 可为空（本地端点没有 Key）：发占位哨兵，不在这里拦', async () => {
    const fetchMock = stubFetch(() => Promise.resolve(okResponse()))

    await expect(
      testChat({ baseUrl: 'http://127.0.0.1:5199/chat/completions', apiKey: '  ', model: 'm' }),
    ).resolves.toBeUndefined()

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer not-needed')
  })

  it('请求体与鉴权头：模型 ID 已 trim，非流式', async () => {
    const fetchMock = stubFetch(() => Promise.resolve(okResponse()))

    await testChat({ baseUrl: 'https://x', apiKey: ' k ', model: ' m ' })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer k',
    })
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'm',
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
      max_tokens: 8,
    })
  })

  it('非 2xx：抛出状态码与响应片段', async () => {
    stubFetch(() => Promise.resolve(new Response('bad key', { status: 401 })))

    await expect(testChat({ baseUrl: 'https://x', apiKey: 'k', model: 'm' })).rejects.toThrow(
      'HTTP 401：bad key',
    )
  })

  it('被中止（超时）时给可读提示', async () => {
    stubFetch(() => Promise.reject(new DOMException('aborted', 'AbortError')))

    await expect(testChat({ baseUrl: 'https://x', apiKey: 'k', model: 'm' })).rejects.toThrow(
      '请求超时（15s）',
    )
  })

  it('其它网络错误原样抛出', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')))

    await expect(testChat({ baseUrl: 'https://x', apiKey: 'k', model: 'm' })).rejects.toThrow(
      'Failed to fetch',
    )
  })

  it('成功时正常返回', async () => {
    stubFetch(() => Promise.resolve(okResponse()))

    await expect(testChat({ baseUrl: 'https://x', apiKey: 'k', model: 'm' })).resolves.toBeUndefined()
  })
})
