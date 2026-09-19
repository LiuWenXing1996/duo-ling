// 全局会话 composable：渲染层的会话状态源。
//
// 布局上对应全局三栏中的「会话历史 + 当前会话」两栏：会话列表读自 IndexedDB（同源共享），
// 消息全部持久化在 IndexedDB，此处只维护「当前激活会话」的视图与流式过程中的临时态。
//
// 定位是「指令入口 + 观察者」（对话链路的执行宿主是 offscreen）：
//   · 落盘归 offscreen —— 用户消息在 chat:start 时落盘、assistant 消息在收尾时落盘
//     （含完整 parts 与 token 用量）；侧边栏**不写**会话库，防双写。
//   · 断线重连 —— 面板重开 / 切回会话时经 chat.resumeStream() → transport.reconnectToStream()
//     从头回放 offscreen 里仍在进行中任务的完整事件缓冲接上；「下完单就走」由此成立。
//   · 孤儿任务 —— offscreen 宿主被杀后 status=running 的记录（心跳过期）在此提示「继续 / 丢弃」。

import { computed, ref, shallowRef, watchEffect } from 'vue'
import { useDataSync } from '@/composables/use-data-sync'
import type { UseChatHelpers } from '@ai-sdk/vue'
import type { ChatInit, ChatStatus, UIMessage } from 'ai'
import { ExtensionChatTransport } from '@/lib/extension-chat-transport'
import { toUiMessage } from '@/lib/conversation-message'
import { getPickedElement } from '@/lib/page-context-store'
import type { ChatOrphanRecord, RuntimeRequest, RuntimeResponse } from '@/shared/extension-ipc'
import type { Conversation, TokenUsage } from '@/shared/types'

/** 会话历史列表项展示所需的时间格式化；补上分钟，便于同日内区分多次会话 */
export function formatSessionTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 从消息 parts 里取 offscreen 推送的 token 用量（data-usage data part） */
function usageOfParts(parts: UIMessage['parts']): TokenUsage | undefined {
  const part = parts.find((p) => p.type === 'data-usage') as
    | { type: 'data-usage'; data: TokenUsage }
    | undefined
  return part?.data
}

/** useChat 实例句柄：按需加载得来，类型取自 @ai-sdk/vue 的导出（仅类型，不进产物） */
type ChatInstance = UseChatHelpers<UIMessage>

/** 孤儿横幅轮询的启动哨兵（composable 可能被多处调用，定时器只起一个） */
let orphanPollStarted = false

/**
 * 全局会话状态源。应在 app.vue 顶层调用一次，再把 state 下发给会话历史 / 当前会话两栏。
 */
export function useGlobalConversation() {
  // —— 会话列表（IndexedDB 直读，按 lastMessageAt 倒序由 store 保证）——
  const conversations = ref<Conversation[]>([])
  const activeConversationId = ref('')
  // —— 各消息本次消耗的 token（按 UIMessage.id 索引，供 ChatPanel 单条展示）——
  const usageByMessageId = ref<Record<string, TokenUsage>>({})
  // —— 孤儿任务（offscreen 宿主被杀后遗留；供 ChatApp 横幅提示「继续 / 丢弃」）——
  const orphanTasks = ref<ChatOrphanRecord[]>([])
  // —— 最近一次生成失败的错误文案（供 ChatPanel 展示；发新消息 / 切会话时清除）——
  // 流中途报错（模型网络错误 / API 失败）必须在此留文案：只摘空气泡而不显示错误的话，
  // 用户看到的就是「发出去没回音、重开也没记录」。
  const chatError = ref('')

  // —— 对话客户端：AI SDK 全家桶按需加载 ——
  //
  // useChat 连带 ai 核心 + zod，生产产物合计约 360KB，是侧边栏 / 工作台首屏最大的一块。
  // 但打开面板要做的事（列会话、读历史消息）全部走 IndexedDB 直读，用不到它 ——
  // 真正需要流式接收的只有「发送」与「续上未完成任务」。故改为首次需要时动态加载：
  // 首帧不再等它，面板立刻可画（首开白屏的主因之一）。
  // 前提已核实：@ai-sdk/vue 的 useChat 不依赖组件实例（无 getCurrentInstance /
  // onScopeDispose 一类钩子），在 setup 作用域之外调用同样成立。
  const transport = new ExtensionChatTransport()
  const chatInit = ref<ChatInit<UIMessage>>({
    transport,
    onError: handleChatError,
    onFinish: handleChatFinish
  })
  const chat = shallowRef<ChatInstance | null>(null)
  let chatLoading: Promise<ChatInstance> | undefined

  // useChat 对 messages 是「原地 push + triggerRef」（数组引用不变），而 ChatPanel 通过 props
  // 接收消息：Vue 对引用不变的 props 会跳过子组件更新，导致发送后新消息不显示（切换会话时
  // 是整数组重新赋值、引用变化，故正常）。这里用 watchEffect 把消息同步为「内容变化即新引用」
  // 的视图源，保证传给 ChatPanel 的 props 引用随之变化。
  //
  // messages 同时是「对话客户端尚未加载」时的消息真相源：历史消息由 IndexedDB 直读后直接落在
  // 这里，加载客户端时再整体移交（见 ensureChat），因此首屏渲染不依赖 AI SDK。
  const messages = shallowRef<UIMessage[]>([])

  /** 取对话客户端；首次调用才发起动态加载（发送 / 续流等真正要用流式能力时再调） */
  function ensureChat(): Promise<ChatInstance> {
    chatLoading ??= import('@ai-sdk/vue').then(({ useChat }) => {
      const instance = useChat(chatInit)
      // 把面板已经读出来的消息交给它当起点，避免流式侧从空列表开始
      instance.messages.value = [...messages.value]
      chat.value = instance
      return instance
    })
    return chatLoading
  }

  watchEffect(() => {
    const instance = chat.value
    if (!instance) return
    messages.value = instance.messages.value ? [...instance.messages.value] : []
  })

  /** 重置当前会话的消息视图：messages 是真相源，客户端已加载时同步给它（它才是流式写入方） */
  function setMessages(next: UIMessage[]): void {
    messages.value = next
    if (chat.value) chat.value.messages.value = next
  }

  /** 读取当前消息列表：客户端已加载时直接读它（流式写入方，免去 watchEffect 的一帧延迟），
   *  否则读视图源。仅供 useChat 回调内部判定用（那些回调只可能由已加载的客户端触发）。 */
  function currentMessages(): UIMessage[] {
    return chat.value ? chat.value.messages.value : messages.value
  }

  /** 是否正在生成（驱动输入禁用与发送/停止切换）；客户端未加载时必然不在生成 */
  const status = computed<ChatStatus>(() => chat.value?.status.value ?? 'ready')
  const streaming = computed(() => status.value === 'submitted' || status.value === 'streaming')

  /** 确保有当前激活会话：无则新建一个（首次进入 / 全部删除后）。返回会话 id。 */
  async function ensureActiveConversation(): Promise<string> {
    if (activeConversationId.value) return activeConversationId.value
    const conv = await window.api.conversation.create()
    conversations.value = [conv, ...conversations.value]
    activeConversationId.value = conv.id
    transport.setConversationId(conv.id)
    setMessages([])
    usageByMessageId.value = {}
    return conv.id
  }

  /** 加载某会话的消息并激活之；若该会话有进行中的任务则重连续流 */
  async function activateConversation(id: string): Promise<void> {
    chat.value?.stop() // 本地断流（不发 chat:abort，offscreen 任务照跑；显式停止走 stopGeneration）
    chatError.value = ''
    activeConversationId.value = id
    transport.setConversationId(id)
    const msgs = await window.api.conversation.messages(id)
    setMessages(msgs.map(toUiMessage))
    // 回读各消息已落盘的 token 用量，供单条展示（id 与 UIMessage.id 一致）；
    // usage 只落在 assistant 分支，先按 role 收窄
    const usageMap: Record<string, TokenUsage> = {}
    for (const m of msgs) {
      if (m.role === 'assistant' && m.usage) usageMap[m.id] = m.usage
    }
    usageByMessageId.value = usageMap
    // 有进行中的任务就接上（transport 内部先 resume replay、再续实时推送）。
    // 这一步会触发对话客户端动态加载；不阻塞首帧 —— 首帧早已画完。
    void ensureChat().then((instance) => instance.resumeStream())
  }

  /** 初次加载会话列表：有则激活第一个，无则新建；顺带拉一次孤儿任务 */
  async function loadConversations(): Promise<void> {
    const list = await window.api.conversation.list()
    conversations.value = list
    if (list.length) {
      await activateConversation(list[0].id)
    } else {
      await ensureActiveConversation()
    }
    void refreshOrphans()
  }

  /** 孤儿任务：offscreen 宿主被杀后遗留；供 ChatApp 横幅提示「继续 / 丢弃」 */
  async function refreshOrphans(): Promise<void> {
    try {
      orphanTasks.value = await chatClient.orphans()
    } catch {
      orphanTasks.value = []
    }
  }

  // 孤儿横幅自动浮现：检测原本只在面板挂载时跑一次——用户若在孤儿判定保护窗
  // （5s）内就重开面板，横幅永远不会出现。轻轮询（15s，一条 sendMessage）兜住
  // 「宿主被杀 → 面板开着」的时间差；轮询随 composable 首次调用启动（面板页单实例）。
  if (!orphanPollStarted) {
    orphanPollStarted = true
    setInterval(() => void refreshOrphans(), 15_000)
  }

  // 别处增删改会话（新建 / 删除 / 重命名）落盘后已广播 `conversation` 域：
  // 回拉列表即可，不动当前激活会话的消息（避免打断进行中的对话）。本 composable 在
  // app 顶层调用一次，订阅随 app 生命周期存活。
  useDataSync('conversation', async () => {
    try {
      conversations.value = await window.api.conversation.list()
    } catch {
      // 列表刷新失败不影响主流程
    }
  })

  /** 孤儿处理：继续（播种内存文件树后重跑循环）或丢弃（删任务记录）。失败须可见——
   *  调用方是 void，异常不接住就全静默（横幅消失但任务还在，用户不知情） */
  async function resolveOrphan(taskId: string, action: 'continue' | 'discard'): Promise<void> {
    try {
      const { conversationId } = await chatClient.orphanAction(taskId, action)
      orphanTasks.value = orphanTasks.value.filter((t) => t.taskId !== taskId)
      if (action === 'continue') {
        await activateConversation(conversationId)
      }
    } catch (e) {
      chatError.value = `孤儿任务处理失败：${e instanceof Error ? e.message : String(e)}`
      void refreshOrphans() // 重新拉一次：失败时横幅不该凭空消失
    }
  }

  /** 新建会话：立即在 offscreen 创建并激活，清空当前视图 */
  async function newConversation(): Promise<void> {
    chat.value?.stop()
    const conv = await window.api.conversation.create()
    conversations.value = [{ ...conv }, ...conversations.value]
    activeConversationId.value = conv.id
    transport.setConversationId(conv.id)
    setMessages([])
    usageByMessageId.value = {}
  }

  /** 删除单个会话：删除后若活跃会话被移除，则激活剩余第一个（否则新建空会话） */
  async function deleteConversation(id: string): Promise<void> {
    await window.api.conversation.delete(id)
    conversations.value = conversations.value.filter((c) => c.id !== id)
    if (activeConversationId.value === id) {
      if (conversations.value.length) {
        await activateConversation(conversations.value[0].id)
      } else {
        await ensureActiveConversation()
      }
    }
  }

  /** 重命名会话：调 offscreen rename，成功后就地更新列表项（返回更新后的 Conversation） */
  async function renameConversation(id: string, title: string): Promise<void> {
    const updated = await window.api.conversation.rename(id, title)
    if (updated) {
      const idx = conversations.value.findIndex((c) => c.id === id)
      if (idx !== -1) conversations.value[idx] = updated
    }
  }

  /** 清空全部会话：删除后列表为空、无活跃会话；下次发送时 send 会自动新建会话 */
  async function deleteAllConversations(): Promise<void> {
    chat.value?.stop()
    await window.api.conversation.deleteAll()
    conversations.value = []
    activeConversationId.value = ''
    transport.setConversationId('')
    usageByMessageId.value = {}
    setMessages([])
  }

  /**
   * 回复完成回调（useChat onFinish）：落盘已由 offscreen 在收尾时完成（唯一写方），
   * 这里只做两件事——读推送来的 token 用量（data-usage part）、刷新会话列表
   * （标题自动命名 / 累计 token 都由写侧维护）。
   */
  async function handleChatFinish({
    message,
    isAbort
  }: {
    message: UIMessage
    isAbort: boolean
  }): Promise<void> {
    // abort 也刷新列表：标题改名发生在 chat:start（offscreen 侧），中止的会话
    // 不刷新的话面板头部一直显示「新会话 N」旧标题
    try {
      conversations.value = await window.api.conversation.list()
    } catch {
      // 列表刷新失败不影响主流程
    }
    if (isAbort) return
    if (!currentMessages().some((m) => m.id === message.id)) return

    const usage = usageOfParts(message.parts)
    if (usage) usageByMessageId.value = { ...usageByMessageId.value, [message.id]: usage }
  }

  /** 出错回调（useChat onError）：错误文案透出到面板（chatError），并移除空副本站避免残留空白气泡 */
  function handleChatError(error?: Error): void {
    chatError.value = error?.message || '生成失败，请稍后重试'
    const list = currentMessages()
    const last = list[list.length - 1]
    const lastParts = last?.parts ?? []
    const hasVisibleContent = lastParts.some(
      (p) =>
        (p.type === 'text' && p.text.trim()) ||
        (p.type === 'reasoning' && p.text.trim()) ||
        p.type.startsWith('tool-') ||
        p.type.startsWith('data-'),
    )
    if (last && last.role === 'assistant' && !hasVisibleContent) {
      setMessages(list.slice(0, -1))
    }
  }

  /**
   * 发送：落盘（用户消息）与执行都在 offscreen —— useChat 自动追加本地视图并触发 transport。
   * 暂存的拾取元素以 metadata 随消息走：offscreen 据此落盘 pageContext 元数据，
   * 本地视图也带上它（气泡 chip 立即可见，不必等重开会话）。
   * 页面快照走 AI 工具采集，不走这条通道。
   */
  async function send(text: string): Promise<void> {
    if (!text || streaming.value) return
    chatError.value = ''
    await ensureActiveConversation()
    const element = getPickedElement()
    const metadata = element ? { pageContext: { element } } : undefined
    const instance = await ensureChat()
    await instance.sendMessage({ text, ...(metadata ? { metadata } : {}) })
  }

  /**
   * 停止生成：本地断流（chat.stop）+ 显式通知 offscreen 终止任务（transport.abortCurrent）。
   * 两步分开的原因：切换会话也走 chat.stop，但那**不该**杀掉 offscreen 里照跑的任务——
   * 只有用户显式点停止才发 chat:abort。
   */
  function stopGeneration(): void {
    chat.value?.stop()
    transport.abortCurrent()
  }

  return {
    // 会话列表
    conversations,
    activeConversationId,
    // 当前会话视图
    messages,
    /** 最近一次生成失败的错误文案（空串 = 无错；展示归 ChatPanel） */
    chatError,
    /** 各消息本次消耗的 token（按 UIMessage.id 索引，供单条展示） */
    usageByMessageId,
    /** offscreen 宿主被杀后遗留的进行中任务（供孤儿横幅） */
    orphanTasks,
    streaming,
    status,
    // 操作
    loadConversations,
    newConversation,
    activateConversation,
    deleteConversation,
    deleteAllConversations,
    renameConversation,
    resolveOrphan,
    send,
    stopGeneration,
    /** 会话历史项展示用：lastMessageAt → 本地时间字符串 */
    formatSessionTime
  }
}

// —— chat:* 命令通道（孤儿查询 / 处理；与 transport 共用共享总线，SW 静默让路） ——

/** 向 offscreen 发 chat:* 命令，统一解包 { ok, data|error } 信封 */
function sendChatCommand<T>(request: RuntimeRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response: RuntimeResponse<T> | undefined) => {
      const lastError = chrome.runtime.lastError
      if (lastError) {
        reject(new Error(lastError.message))
        return
      }
      if (!response) {
        reject(new Error('offscreen 无响应'))
        return
      }
      if (!response.ok) {
        reject(new Error(response.error))
        return
      }
      resolve(response.data as T)
    })
  })
}

/** 孤儿任务的命令面（供本 composable 使用） */
const chatClient = {
  orphans: (): Promise<ChatOrphanRecord[]> => sendChatCommand({ kind: 'chat:orphans' }),
  orphanAction: (taskId: string, action: 'continue' | 'discard'): Promise<{ conversationId: string }> =>
    sendChatCommand({ kind: 'chat:orphanAction', taskId, action }),
}
