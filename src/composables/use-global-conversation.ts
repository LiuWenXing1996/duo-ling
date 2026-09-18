// 全局会话 composable：把「会话」从工具分桶（localStorage）提升为一等公民的渲染层状态源。
//
// 布局上对应全局三栏中的「会话历史 + 当前会话」两栏：会话列表读自 IndexedDB（同源共享），
// 消息全部持久化在 IndexedDB，此处只维护「当前激活会话」的视图与流式过程中的临时态。
//
// 2026-09-15：整条对话链路搬进 offscreen 后，
// 本 composable 的定位收敛为「指令入口 + 观察者」：
//   · 落盘归 offscreen —— 用户消息在 chat:start 时落盘、assistant 消息在收尾时落盘
//     （含完整 parts 与 token 用量）；侧边栏**不写**会话库，防双写。
//   · 断线重连 —— 面板重开 / 切回会话时经 chat.resumeStream() → transport.reconnectToStream()
//     从头回放 offscreen 里仍在进行中任务的完整事件缓冲接上；「下完单就走」由此成立。
//   · 孤儿任务 —— offscreen 宿主被杀后 status=running 的记录（心跳过期）在此提示「继续 / 丢弃」。
//
// 2026-09-14：工具链路移除后，原「多工具意图」分支
// （parseGeneratedIntents / applyIntents / 变更卡片 pendingMap / onToolApplied）整体摘除。

import { computed, ref, shallowRef, watchEffect } from 'vue'
import { useChat } from '@ai-sdk/vue'
import { type ChatInit, type UIMessage } from 'ai'
import { ExtensionChatTransport } from '@/lib/extension-chat-transport'
import { getPickedElement } from '@/lib/page-context-store'
import type { ChatOrphanRecord, RuntimeRequest, RuntimeResponse } from '@/shared/extension-ipc'
import type { Conversation, Message, TokenUsage } from '@/shared/types'

/** 会话历史列表项展示所需的时间格式化；补上分钟，便于同日内区分多次会话 */
export function formatSessionTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 主进程 Message → 渲染层 UIMessage。
 * 消息持久化时均带完整 parts（reasoning/text/tool/data），直接还原分轮思考与工具卡；
 * parts 缺失时按空处理（前提：写入层保证 parts 必填，见 offscreen chat-host 持久化）。
 * pageContext 元数据挂回 metadata：气泡 chip 与「最近一次拾取」prompt 注入都认它。 */
function toUiMessage(m: Message): UIMessage {
  const metadata = m.pageContext ? { pageContext: m.pageContext } : undefined
  return {
    id: m.id,
    role: m.role,
    parts: m.parts ?? [],
    ...(metadata ? { metadata } : {}),
  }
}

/** 从消息 parts 里取 offscreen 推送的 token 用量（data-usage data part） */
function usageOfParts(parts: UIMessage['parts']): TokenUsage | undefined {
  const part = parts.find((p) => p.type === 'data-usage') as
    | { type: 'data-usage'; data: TokenUsage }
    | undefined
  return part?.data
}

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
  // 2026-09-15 手测教训：流中途报错（模型网络错误 / API 失败）原本全静默——
  // 面板只摘掉空气泡，错误文案从不显示，用户看到的就是「发出去没回音、重开也没记录」。
  const chatError = ref('')

  // —— useChat：单个稳定 VueChat 实例；切换会话时直接重置 messages（ShallowRef 可安全赋值）——
  const transport = new ExtensionChatTransport()
  const chatInit = ref<ChatInit<UIMessage>>({
    transport,
    onError: handleChatError,
    onFinish: handleChatFinish
  })
  const chat = useChat(chatInit)
  // useChat 对 messages 是「原地 push + triggerRef」（数组引用不变），而 ChatPanel 通过 props
  // 接收消息：Vue 对引用不变的 props 会跳过子组件更新，导致发送后新消息不显示（切换会话时
  // 是整数组重新赋值、引用变化，故正常）。这里用 watchEffect 把消息同步为「内容变化即新引用」
  // 的视图源，保证传给 ChatPanel 的 props 引用随之变化。
  const messages = shallowRef<UIMessage[]>([])
  watchEffect(() => {
    messages.value = chat.messages.value ? [...chat.messages.value] : []
  })
  const status = chat.status
  /** 是否正在生成（驱动输入禁用与发送/停止切换） */
  const streaming = computed(() => status.value === 'submitted' || status.value === 'streaming')

  /** 确保有当前激活会话：无则新建一个（首次进入 / 全部删除后）。返回会话 id。 */
  async function ensureActiveConversation(): Promise<string> {
    if (activeConversationId.value) return activeConversationId.value
    const conv = await window.api.conversation.create()
    conversations.value = [conv, ...conversations.value]
    activeConversationId.value = conv.id
    transport.setConversationId(conv.id)
    chat.messages.value = []
    usageByMessageId.value = {}
    return conv.id
  }

  /** 加载某会话的消息并激活之；若该会话有进行中的任务则重连续流 */
  async function activateConversation(id: string): Promise<void> {
    chat.stop() // 本地断流（不发 chat:abort，offscreen 任务照跑；显式停止走 stopGeneration）
    chatError.value = ''
    activeConversationId.value = id
    transport.setConversationId(id)
    const msgs = await window.api.conversation.messages(id)
    chat.messages.value = msgs.map(toUiMessage)
    // 回读各消息已落盘的 token 用量，供单条展示（id 与 UIMessage.id 一致）
    const usageMap: Record<string, TokenUsage> = {}
    for (const m of msgs) {
      if (m.usage) usageMap[m.id] = m.usage
    }
    usageByMessageId.value = usageMap
    // 有进行中的任务就接上（transport 内部先 resume replay、再续实时推送）
    void chat.resumeStream()
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
    chat.stop()
    const conv = await window.api.conversation.create()
    conversations.value = [{ ...conv }, ...conversations.value]
    activeConversationId.value = conv.id
    transport.setConversationId(conv.id)
    chat.messages.value = []
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
    chat.stop()
    await window.api.conversation.deleteAll()
    conversations.value = []
    activeConversationId.value = ''
    transport.setConversationId('')
    usageByMessageId.value = {}
    chat.messages.value = []
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
    // 不刷新的话面板头部一直显示「新会话 N」旧标题（2026-09-15 手测实测）
    try {
      conversations.value = await window.api.conversation.list()
    } catch {
      // 列表刷新失败不影响主流程
    }
    if (isAbort) return
    if (!chat.messages.value.some((m) => m.id === message.id)) return

    const usage = usageOfParts(message.parts)
    if (usage) usageByMessageId.value = { ...usageByMessageId.value, [message.id]: usage }
  }

  /** 出错回调（useChat onError）：错误文案透出到面板（chatError），并移除空副本站避免残留空白气泡 */
  function handleChatError(error?: Error): void {
    chatError.value = error?.message || '生成失败，请稍后重试'
    const last = chat.messages.value[chat.messages.value.length - 1]
    const lastParts = last?.parts ?? []
    const hasVisibleContent = lastParts.some(
      (p) =>
        (p.type === 'text' && p.text.trim()) ||
        (p.type === 'reasoning' && p.text.trim()) ||
        p.type.startsWith('tool-') ||
        p.type.startsWith('data-'),
    )
    if (last && last.role === 'assistant' && !hasVisibleContent) {
      chat.messages.value = chat.messages.value.slice(0, -1)
    }
  }

  /**
   * 发送：落盘（用户消息）与执行都在 offscreen —— useChat 自动追加本地视图并触发 transport。
   * 暂存的拾取元素以 metadata 随消息走：offscreen 据此落盘 pageContext 元数据，
   * 本地视图也带上它（气泡 chip 立即可见，不必等重开会话）。
   * 页面快照已改 AI 工具采集（2026-09-17），不走这条通道。
   */
  async function send(text: string): Promise<void> {
    if (!text || streaming.value) return
    chatError.value = ''
    await ensureActiveConversation()
    const element = getPickedElement()
    const metadata = element ? { pageContext: { element } } : undefined
    await chat.sendMessage({ text, ...(metadata ? { metadata } : {}) })
  }

  /**
   * 停止生成：本地断流（chat.stop）+ 显式通知 offscreen 终止任务（transport.abortCurrent）。
   * 两步分开的原因：切换会话也走 chat.stop，但那**不该**杀掉 offscreen 里照跑的任务——
   * 只有用户显式点停止才发 chat:abort。
   */
  function stopGeneration(): void {
    chat.stop()
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
