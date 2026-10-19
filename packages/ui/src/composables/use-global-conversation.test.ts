// 会话状态源的契约：归属按标签页解析、惰性新建、收尾回填、孤儿处理。
//
// 本文件不必挂载组件 —— 该 composable 只用 ref / computed / watchEffect，没有 onMounted。
// 依赖面较宽，故除 vue 与纯函数模块外一律换替身：
//   · @/lib/conversation-client  —— 会话库读面（模块替身，路径即包内 `../lib/conversation-client`）
//   · ExtensionChatTransport     —— 只验它收到哪些调用（构造即实例化，故整体替身掉）
//   · @ai-sdk/vue                —— 动态 import，替身返回可手控的 useChat 句柄
//   · conversation-tab-map       —— IDB 归属映射（本仓另有专项测试），此处只验调用参数
//   · owning-tab                 —— 标签页归属解析
//   · use-data-sync              —— 收下回调，用例里手动触发
//   · runtime-send               —— chat:orphans / chat:orphanAction 命令
//
// 一处副作用要留意：composable 在调用点启动 15s 孤儿轮询（模块级哨兵，只起一次）。
// 用例时长远小于该间隔，故轮询不会在测试期间触发。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRef, ref, toRaw, type Ref } from 'vue'
import type { ChatStatus, UIMessage } from 'ai'
import type { ChatMessageMetadata, ChatOrphanRecord, RuntimeRequest } from '@duoling/shared'
import type { ElementPickContext } from '@duoling/shared'
import type {
  AssistantMessage,
  Conversation,
  Message,
  TokenUsage,
  UserMessage,
} from '@duoling/shared'
import { messageTime } from '@duoling/shared'
import type { ChatAssetRef } from '@duoling/shared'
import { clearPickedElement, setPickedElement } from '../lib/page-context-store'
import { bindTabToConversation, getConversationIdForTab, unbindTab } from '@duoling/shared'
import { resolveOwningTabId } from '../lib/owning-tab'
import { ipcRequest } from '@duoling/shared'
import { useGlobalConversation } from './use-global-conversation'

// vi.mock 工厂被提升到 import 之前，跨用例共享的登记容器须用 vi.hoisted 预置
const h = vi.hoisted(() => ({
  transports: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  chatInits: [] as unknown[],
  chatInstances: [] as unknown[],
  dataSync: [] as Array<{ domains: string[]; reload: (push: { domain: string }) => unknown }>,
}))

/** 会话库读面替身：composable 直接 import 该模块，故在模块级替身（默认值在 beforeEach 给） */
const conversationApi = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  messages: vi.fn(),
}))
vi.mock('../lib/conversation-client', () => ({ conversationClient: conversationApi }))

vi.mock('../lib/extension-chat-transport', () => ({
  ExtensionChatTransport: class {
    setConversationId = vi.fn()
    abortCurrent = vi.fn()
    sendMessages = vi.fn()
    reconnectToStream = vi.fn()
    constructor() {
      h.transports.push(this as unknown as Record<string, ReturnType<typeof vi.fn>>)
    }
  },
}))

vi.mock('@ai-sdk/vue', () => ({
  useChat: vi.fn((init: unknown) => {
    const instance = {
      messages: ref<UIMessage[]>([]),
      status: ref<ChatStatus>('ready'),
      error: ref<unknown>(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      resumeStream: vi.fn().mockResolvedValue(undefined),
    }
    h.chatInits.push(init)
    h.chatInstances.push(instance)
    return instance
  }),
}))

vi.mock('./use-data-sync', () => ({
  useDataSync: (domains: string | string[], reload: (push: { domain: string }) => unknown) => {
    h.dataSync.push({ domains: Array.isArray(domains) ? domains : [domains], reload })
  },
}))

vi.mock('../lib/owning-tab', () => ({ resolveOwningTabId: vi.fn() }))
// 归属映射与总线都在 shared 一个包根上：合并替身（spread 保其余符号真身）
vi.mock('@duoling/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@duoling/shared')>()),
  ipcRequest: vi.fn(),
  getConversationIdForTab: vi.fn(),
  bindTabToConversation: vi.fn(),
  unbindTab: vi.fn(),
}))

/** 会话列表项与消息的固定基准时刻 */
const T0 = '2024-05-06T07:08:09.000Z'

function conversation(id: string, over: Partial<Conversation> = {}): Conversation {
  return { id, title: `会话 ${id}`, createdAt: T0, lastMessageAt: T0, ...over }
}

function assistantMessage(id: string, over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id,
    conversationId: 'c1',
    content: '',
    parts: [],
    createdAt: T0,
    role: 'assistant',
    ...over,
  }
}

function userMessage(id: string, over: Partial<UserMessage> = {}): UserMessage {
  return { id, conversationId: 'c1', content: '', parts: [], createdAt: T0, role: 'user', ...over }
}

/** 面板侧消息视图；metadata 留空，便于断言「补时间」前后的差别 */
function uiMessage(id: string, role: 'user' | 'assistant', parts: unknown[] = []): UIMessage {
  return { id, role, parts, metadata: {} } as unknown as UIMessage
}

/** 构造一个仅用于观察的 data-usage part */
function usagePart(usage: TokenUsage): unknown {
  return { type: 'data-usage', data: usage }
}

interface FakeChat {
  messages: Ref<UIMessage[]>
  status: Ref<ChatStatus>
  sendMessage: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  resumeStream: ReturnType<typeof vi.fn>
}

interface FakeInit {
  transport: unknown
  onFinish: (options: { message: UIMessage; isAbort: boolean }) => Promise<void>
  onError: (error?: Error) => void
}

interface SentMessage {
  parts: UIMessage['parts']
  metadata: ChatMessageMetadata
}

const chatAt = (index = -1): FakeChat =>
  h.chatInstances[index < 0 ? h.chatInstances.length + index : index] as FakeChat
const lastChat = (): FakeChat => chatAt()
const firstChat = (): FakeChat => chatAt(0)
/** 自持的流式通道替身（每个 composable 实例一个，取 0 号） */
const transport = (): Record<string, ReturnType<typeof vi.fn>> =>
  h.transports[0] as Record<string, ReturnType<typeof vi.fn>>
/** useChat 收到的初始化对象（携带 onFinish / onError / transport）。
 *  源码传的是承载它的 ref（`useChat(chatInit)`），故取用时解包 */
const lastInit = (): FakeInit => {
  const raw = h.chatInits[h.chatInits.length - 1]
  return (isRef(raw) ? raw.value : raw) as FakeInit
}
/** 会话域变更订阅（用例里手动触发回拉） */
const conversationSync = (): { domains: string[]; reload: (push: { domain: string }) => unknown } =>
  h.dataSync[h.dataSync.length - 1] as {
    domains: string[]
    reload: (push: { domain: string }) => unknown
  }
/** 客户端最后一次发出的消息参数 */
const lastSent = (chat: FakeChat = lastChat()): SentMessage => {
  const calls = chat.sendMessage.mock.calls
  return calls[calls.length - 1][0] as SentMessage
}

/** 让出一轮宏任务：composable 里若干处是 `void refreshOrphans()` 这类不等待的调用 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function createState(): ReturnType<typeof useGlobalConversation> {
  return useGlobalConversation()
}

/** 建实例并走一遍初次加载 */
async function stateLoaded(
  options: { list?: Conversation[]; owningTab?: number | null; bound?: string | null } = {},
): Promise<ReturnType<typeof useGlobalConversation>> {
  conversationApi.list.mockResolvedValue(options.list ?? [])
  vi.mocked(resolveOwningTabId).mockResolvedValue(options.owningTab ?? null)
  vi.mocked(getConversationIdForTab).mockResolvedValue(options.bound ?? null)
  const state = createState()
  await state.loadConversations()
  await tick()
  return state
}

/** 建实例并确保对话客户端已加载（发一条消息触发动态 import） */
async function stateWithChat(): Promise<ReturnType<typeof useGlobalConversation>> {
  conversationApi.create.mockResolvedValue(conversation('c1'))
  const state = await stateLoaded()
  await state.send('热身')
  return state
}

/** 建实例、激活 c1（含给定消息）、并确保对话客户端已加载 */
async function stateOnC1(
  messages: Message[] = [],
): Promise<ReturnType<typeof useGlobalConversation>> {
  conversationApi.messages.mockResolvedValue(messages)
  const state = await stateLoaded({ list: [conversation('c1')], owningTab: 7, bound: 'c1' })
  await state.send('热身')
  return state
}

beforeEach(() => {
  vi.clearAllMocks()
  h.transports.length = 0
  h.chatInits.length = 0
  h.chatInstances.length = 0
  h.dataSync.length = 0
  vi.mocked(resolveOwningTabId).mockResolvedValue(null)
  vi.mocked(getConversationIdForTab).mockResolvedValue(null)
  vi.mocked(bindTabToConversation).mockResolvedValue(undefined)
  vi.mocked(unbindTab).mockResolvedValue(undefined)
  vi.mocked(ipcRequest).mockResolvedValue([])
  conversationApi.create.mockResolvedValue(conversation('c-new'))
  conversationApi.list.mockResolvedValue([])
  conversationApi.messages.mockResolvedValue([])
})

afterEach(() => {
  clearPickedElement()
})

describe('formatSessionTime（会话历史项展示）', () => {
  it('ISO 时间按本地时区格式化为「YYYY-MM-DD HH:mm」', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5)
    const { formatSessionTime } = createState()
    expect(formatSessionTime(d.toISOString())).toBe('2026-01-02 03:04')
  })

  it('解析不出时间的串给空串：调用方据此不渲染那一格', () => {
    const { formatSessionTime } = createState()
    expect(formatSessionTime('not-a-date')).toBe('')
  })
})

describe('状态初值', () => {
  it('对话客户端尚未加载：状态 ready、不在生成中、没有激活会话', () => {
    const state = createState()
    expect(state.status.value).toBe('ready')
    expect(state.streaming.value).toBe(false)
    expect(state.activeConversationId.value).toBe('')
    expect(h.chatInstances).toHaveLength(0)
  })
})

describe('惰性新建（发送入口）', () => {
  it('未绑定态下发送：先建会话、登记归属，再把消息交给对话客户端', async () => {
    conversationApi.create.mockResolvedValue(conversation('c1'))
    const state = await stateLoaded({ owningTab: 7 })

    await state.send('你好')

    expect(conversationApi.create).toHaveBeenCalledTimes(1)
    expect(state.activeConversationId.value).toBe('c1')
    expect(state.conversations.value.map((c) => c.id)).toEqual(['c1'])
    expect(transport().setConversationId).toHaveBeenLastCalledWith('c1')
    expect(vi.mocked(bindTabToConversation)).toHaveBeenCalledWith(7, 'c1')
    expect(lastChat().sendMessage).toHaveBeenCalledTimes(1)
    expect(lastSent().parts).toEqual([{ type: 'text', text: '你好' }])
  })

  it('已有归属会话时发送：复用当前会话，不重复新建', async () => {
    const state = await stateOnC1()

    await state.send('接着聊')

    expect(conversationApi.create).not.toHaveBeenCalled()
    expect(lastChat().sendMessage).toHaveBeenCalledTimes(2) // 热身那条 + 本条
    expect(lastSent().parts).toEqual([{ type: 'text', text: '接着聊' }])
  })

  it('取不到标签页归属：照常建会话与对话，只是不登记映射', async () => {
    conversationApi.create.mockResolvedValue(conversation('c1'))
    const state = await stateLoaded({ owningTab: null })

    await state.send('你好')

    expect(conversationApi.create).toHaveBeenCalledTimes(1)
    expect(vi.mocked(bindTabToConversation)).not.toHaveBeenCalled()
    expect(lastChat().sendMessage).toHaveBeenCalledTimes(1)
  })

  it('登记归属失败不拦对话：会话已建好，本轮不归属标签页', async () => {
    conversationApi.create.mockResolvedValue(conversation('c1'))
    vi.mocked(bindTabToConversation).mockRejectedValue(new Error('端口已断'))
    const state = await stateLoaded({ owningTab: 7 })

    await expect(state.send('你好')).resolves.toBeUndefined()

    expect(lastChat().sendMessage).toHaveBeenCalledTimes(1)
  })

  it('空白正文且无附件：直接返回，既不建会话也不加载客户端', async () => {
    const state = createState()
    await state.send('')

    expect(conversationApi.create).not.toHaveBeenCalled()
    expect(h.chatInstances).toHaveLength(0)
  })

  it('正在生成时忽略新的发送请求', async () => {
    const state = await stateWithChat()
    const chat = lastChat()
    chat.status.value = 'streaming'
    expect(state.streaming.value).toBe(true)

    await state.send('第二条')

    expect(chat.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('只带附件也能发送：正文缺省时不产生 text part，附件以 data-asset 挂在 parts 上', async () => {
    conversationApi.create.mockResolvedValue(conversation('c1'))
    const state = await stateLoaded()
    const assets: ChatAssetRef[] = [
      { id: 'a'.repeat(64), filename: 'shot.png', mediaType: 'image/png', size: 3 },
    ]

    await state.send('', assets)

    expect(lastSent().parts).toEqual([{ type: 'data-asset', data: assets[0] }])
  })

  it('正文与附件都有：附件在前、正文在后（与 SDK 内部顺序一致）', async () => {
    conversationApi.create.mockResolvedValue(conversation('c1'))
    const state = await stateLoaded()
    const assets: ChatAssetRef[] = [
      { id: 'a'.repeat(64), filename: 'shot.png', mediaType: 'image/png', size: 3 },
    ]

    await state.send('看看这张', assets)

    expect(lastSent().parts).toEqual([
      { type: 'data-asset', data: assets[0] },
      { type: 'text', text: '看看这张' },
    ])
  })

  it('发送时带上 metadata.createdAt：面板不写会话库，气泡时间只能在此取', async () => {
    conversationApi.create.mockResolvedValue(conversation('c1'))
    const state = await stateLoaded()

    await state.send('你好')

    const createdAt = lastSent().metadata.createdAt ?? ''
    expect(Number.isNaN(Date.parse(createdAt))).toBe(false)
  })

  it('暂存的拾取元素随消息以 pageContext 发出', async () => {
    conversationApi.create.mockResolvedValue(conversation('c1'))
    const state = await stateLoaded()
    const element = { pickedAt: 1, pageUrl: 'https://example.com' } as unknown as ElementPickContext
    setPickedElement(element)

    await state.send('看看这个')

    expect(lastSent().metadata.pageContext).toEqual({ element })
  })
})

describe('初次加载与切标签页', () => {
  it('初次加载拉会话列表，但不自动激活最新那条（归属由标签页决定）', async () => {
    const state = await stateLoaded({
      list: [conversation('c1'), conversation('c2')],
      owningTab: null,
    })

    expect(state.conversations.value.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(state.activeConversationId.value).toBe('')
  })

  it('列表为空是合法起点：停在未绑定态，不新建空会话', async () => {
    const state = await stateLoaded({ list: [], owningTab: 7 })

    expect(state.activeConversationId.value).toBe('')
    expect(conversationApi.create).not.toHaveBeenCalled()
  })

  it('映射有效：激活那条会话、回读消息并把会话 id 交给通道', async () => {
    conversationApi.messages.mockResolvedValue([userMessage('u1')])
    const state = await stateLoaded({ list: [conversation('c1')], owningTab: 7, bound: 'c1' })

    expect(state.activeConversationId.value).toBe('c1')
    expect(transport().setConversationId).toHaveBeenLastCalledWith('c1')
    expect(conversationApi.messages).toHaveBeenCalledWith('c1')
  })

  it('已经在这条会话上：不重读消息，避免打断进行中的流', async () => {
    conversationApi.messages.mockResolvedValue([userMessage('u1')])
    const state = await stateLoaded({ list: [conversation('c1')], owningTab: 7, bound: 'c1' })
    expect(conversationApi.messages).toHaveBeenCalledTimes(1)

    await state.loadConversations()

    expect(conversationApi.messages).toHaveBeenCalledTimes(1)
    expect(state.activeConversationId.value).toBe('c1')
  })

  it('映射指向的会话已不在库里：清掉陈旧映射并回到未绑定态', async () => {
    const state = await stateLoaded({ list: [conversation('c9')], owningTab: 7, bound: 'c-gone' })

    expect(vi.mocked(unbindTab)).toHaveBeenCalledWith(7)
    expect(state.activeConversationId.value).toBe('')
  })

  it('取不到标签页：进入未绑定态，清空会话 id、消息与用量', async () => {
    const usage: TokenUsage = { totalTokens: 5 }
    const state = await stateOnC1([assistantMessage('a1', { usage })])
    expect(state.messages.value.map((m) => m.id)).toEqual(['a1'])
    expect(state.usageByMessageId.value).toEqual({ a1: usage })

    vi.mocked(resolveOwningTabId).mockResolvedValue(null)
    await state.loadConversations()

    expect(state.activeConversationId.value).toBe('')
    expect(state.messages.value).toEqual([])
    expect(state.usageByMessageId.value).toEqual({})
    expect(transport().setConversationId).toHaveBeenLastCalledWith('')
    expect(lastChat().stop).toHaveBeenCalled()
  })
})

describe('激活会话', () => {
  it('回读消息并转成视图，只收 assistant 的 token 用量，同时触发续流', async () => {
    const usage: TokenUsage = { inputTokens: 3, outputTokens: 4, totalTokens: 7 }
    const state = await stateOnC1([userMessage('u1'), assistantMessage('a1', { usage })])

    expect(state.messages.value.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(state.messages.value.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(state.usageByMessageId.value).toEqual({ a1: usage })
    expect(lastChat().resumeStream).toHaveBeenCalledTimes(1)
  })

  it('切到另一条会话时清掉上一轮的出错文案', async () => {
    const state = await stateOnC1()
    lastInit().onError(new Error('上一轮的错'))
    expect(state.chatError.value).toBe('上一轮的错')

    conversationApi.list.mockResolvedValue([conversation('c1'), conversation('c2')])
    vi.mocked(getConversationIdForTab).mockResolvedValue('c2')
    vi.mocked(resolveOwningTabId).mockResolvedValue(7)
    await state.loadConversations()

    expect(state.activeConversationId.value).toBe('c2')
    expect(state.chatError.value).toBe('')
  })
})

describe('收尾回调', () => {
  it('初始化对象带上自持 transport 与收尾 / 出错回调', async () => {
    await stateWithChat()

    const init = lastInit()
    // transport 装进 init 后被深层响应式包裹，读出来是代理：脱壳再比引用；只有一个实例即「自持」
    expect(toRaw(init.transport)).toBe(transport())
    expect(h.transports).toHaveLength(1)
    expect(typeof init.onFinish).toBe('function')
    expect(typeof init.onError).toBe('function')
  })

  it('收尾：给这条回复补上展示时间并刷新会话列表', async () => {
    const state = await stateOnC1([assistantMessage('a1', { createdAt: '' })])
    const renamed = [conversation('c1', { title: '自动命名' })]
    conversationApi.list.mockResolvedValue(renamed)

    await lastInit().onFinish({ message: uiMessage('a1', 'assistant'), isAbort: false })

    expect(messageTime(state.messages.value[0] as UIMessage)).not.toBe('')
    expect(state.conversations.value).toEqual(renamed)
  })

  it('被中止的回复同样补时间，但不记 token 用量', async () => {
    const state = await stateOnC1([assistantMessage('a1', { createdAt: '' })])

    await lastInit().onFinish({
      message: uiMessage('a1', 'assistant', [usagePart({ totalTokens: 5 })]),
      isAbort: true,
    })

    expect(messageTime(state.messages.value[0] as UIMessage)).not.toBe('')
    expect(state.usageByMessageId.value).toEqual({})
  })

  it('收尾时把推送来的 data-usage 记到该条消息名下', async () => {
    const usage: TokenUsage = { inputTokens: 3, outputTokens: 4, totalTokens: 7 }
    const state = await stateWithChat()
    lastChat().messages.value = [uiMessage('a1', 'assistant', [{ type: 'text', text: '答' }])]

    await lastInit().onFinish({
      message: uiMessage('a1', 'assistant', [usagePart(usage)]),
      isAbort: false,
    })

    expect(state.usageByMessageId.value).toEqual({ a1: usage })
  })

  it('收尾消息里没有 data-usage：不产生用量记录', async () => {
    const state = await stateWithChat()
    lastChat().messages.value = [uiMessage('a1', 'assistant', [{ type: 'text', text: '答' }])]

    await lastInit().onFinish({
      message: uiMessage('a1', 'assistant', [{ type: 'text', text: '答' }]),
      isAbort: false,
    })

    expect(state.usageByMessageId.value).toEqual({})
  })

  it('收尾的消息不在当前列表（已切走）：只刷新列表，不记账', async () => {
    const state = await stateWithChat()
    lastChat().messages.value = [uiMessage('a1', 'assistant', [{ type: 'text', text: '答' }])]

    await lastInit().onFinish({
      message: uiMessage('别的消息', 'assistant', [usagePart({ totalTokens: 9 })]),
      isAbort: false,
    })

    expect(state.usageByMessageId.value).toEqual({})
  })
})

describe('出错回调', () => {
  it('错误文案透出到面板', async () => {
    const state = await stateWithChat()
    lastInit().onError(new Error('上游 500'))
    expect(state.chatError.value).toBe('上游 500')
  })

  it('没有错误对象时给一句兜底文案', async () => {
    const state = await stateWithChat()
    lastInit().onError()
    expect(state.chatError.value).toBe('生成失败，请稍后重试')
  })

  it('末条是空内容的 assistant 半截：移除它，不留空白气泡', async () => {
    await stateWithChat()
    const chat = lastChat()
    chat.messages.value = [
      uiMessage('u1', 'user', [{ type: 'text', text: '提问' }]),
      uiMessage('a1', 'assistant', [{ type: 'text', text: '   ' }]),
    ]

    lastInit().onError(new Error('断了'))

    expect(chat.messages.value.map((m) => m.id)).toEqual(['u1'])
  })

  it('末条 assistant 已有半截正文：保留并补上时间', async () => {
    await stateWithChat()
    const chat = lastChat()
    chat.messages.value = [uiMessage('a1', 'assistant', [{ type: 'text', text: '正在' }])]

    lastInit().onError(new Error('断了'))

    expect(chat.messages.value).toHaveLength(1)
    expect(messageTime(chat.messages.value[0] as UIMessage)).not.toBe('')
  })

  it('末条只带工具 / 数据 part：算有可见内容，不移除', async () => {
    await stateWithChat()
    const chat = lastChat()
    chat.messages.value = [uiMessage('a1', 'assistant', [usagePart({ totalTokens: 1 })])]

    lastInit().onError(new Error('断了'))

    expect(chat.messages.value.map((m) => m.id)).toEqual(['a1'])
  })

  it('末条是用户消息：既不补时间也不移除', async () => {
    await stateWithChat()
    const chat = lastChat()
    chat.messages.value = [uiMessage('u1', 'user', [{ type: 'text', text: '提问' }])]

    lastInit().onError(new Error('断了'))

    expect(chat.messages.value.map((m) => m.id)).toEqual(['u1'])
    expect(messageTime(chat.messages.value[0] as UIMessage)).toBe('')
  })
})

describe('孤儿任务', () => {
  const orphan: ChatOrphanRecord = { taskId: 't1', conversationId: 'c1', step: 3, heartbeat: 1 }

  it('初次加载顺带拉一次孤儿任务', async () => {
    vi.mocked(ipcRequest).mockResolvedValue([orphan])
    const state = await stateLoaded()

    expect(state.orphanTasks.value).toEqual([orphan])
  })

  it('孤儿任务拉取失败：置空而不抛错', async () => {
    vi.mocked(ipcRequest).mockRejectedValue(new Error('SW 未响应'))
    const state = await stateLoaded()

    expect(state.orphanTasks.value).toEqual([])
  })

  it('「继续」：摘掉横幅项并跳到那条会话', async () => {
    vi.mocked(ipcRequest).mockImplementation(async (request: RuntimeRequest): Promise<unknown> => {
      if (request.kind === 'chat:orphans') return [orphan]
      return { conversationId: 'c1' }
    })
    conversationApi.messages.mockResolvedValue([userMessage('u1')])
    const state = await stateLoaded({ list: [conversation('c1')] })
    expect(state.orphanTasks.value).toHaveLength(1)

    await state.resolveOrphan('t1', 'continue')

    expect(state.orphanTasks.value).toEqual([])
    expect(conversationApi.messages).toHaveBeenCalledWith('c1')
    expect(state.activeConversationId.value).toBe('c1')
  })

  it('「丢弃」：只摘掉横幅项，不跳转', async () => {
    vi.mocked(ipcRequest).mockImplementation(async (request: RuntimeRequest): Promise<unknown> => {
      if (request.kind === 'chat:orphans') return [orphan]
      return { conversationId: 'c1' }
    })
    const state = await stateLoaded()
    expect(state.orphanTasks.value).toHaveLength(1)

    await state.resolveOrphan('t1', 'discard')

    expect(state.orphanTasks.value).toEqual([])
    expect(conversationApi.messages).not.toHaveBeenCalled()
  })

  it('处理失败：文案透出到面板，并重新拉一次列表', async () => {
    let orphanPulls = 0
    vi.mocked(ipcRequest).mockImplementation(async (request: RuntimeRequest): Promise<unknown> => {
      if (request.kind === 'chat:orphans') {
        orphanPulls += 1
        return []
      }
      throw new Error('任务已被回收')
    })
    const state = await stateLoaded()
    const before = orphanPulls

    await state.resolveOrphan('t1', 'discard')
    await tick()

    expect(state.chatError.value).toContain('任务已被回收')
    expect(orphanPulls).toBeGreaterThan(before)
  })
})

describe('停止生成', () => {
  it('本地断流并显式通知 offscreen 终止任务', async () => {
    const state = await stateWithChat()

    state.stopGeneration()

    expect(firstChat().stop).toHaveBeenCalledTimes(1)
    expect(transport().abortCurrent).toHaveBeenCalledTimes(1)
  })
})

describe('会话域变更订阅', () => {
  it('订阅的是会话域', () => {
    createState()
    expect(conversationSync().domains).toEqual(['conversation'])
  })

  it('当前会话仍在列表里：刷新列表，不动激活会话', async () => {
    const state = await stateLoaded({ list: [conversation('c1')], owningTab: 7, bound: 'c1' })
    const renamed = [conversation('c1', { title: '改过名' })]
    conversationApi.list.mockResolvedValue(renamed)

    await conversationSync().reload({ domain: 'conversation' })

    expect(state.conversations.value).toEqual(renamed)
    expect(state.activeConversationId.value).toBe('c1')
  })

  it('当前会话已被删：解绑标签页并回到未绑定态', async () => {
    const state = await stateLoaded({ list: [conversation('c1')], owningTab: 7, bound: 'c1' })
    conversationApi.list.mockResolvedValue([conversation('c2')])

    await conversationSync().reload({ domain: 'conversation' })

    expect(vi.mocked(unbindTab)).toHaveBeenCalledWith(7)
    expect(state.activeConversationId.value).toBe('')
  })

  it('刷新列表失败：不抛错，激活会话保持不动', async () => {
    const state = await stateLoaded({ list: [conversation('c1')], owningTab: 7, bound: 'c1' })
    conversationApi.list.mockRejectedValue(new Error('读库失败'))

    await expect(conversationSync().reload({ domain: 'conversation' })).resolves.toBeUndefined()

    expect(state.activeConversationId.value).toBe('c1')
  })
})
