// 全局会话 composable：把「会话」从工具分桶（localStorage）提升为主进程一等公民的渲染层状态源。
//
// 布局上对应全局三栏中的「会话历史 + 当前会话」两栏：会话列表来自主进程 conversation-store，
// 消息与 EditIntent 全部持久化在主进程，此处只维护「当前激活会话」的视图与流式过程中的临时态。
//
// 方案 B（切进 AI SDK 全家桶）后的关键行为：
//   - 用 @ai-sdk/vue useChat({ transport }) 驱动整条对话链路，消息模型为 UIMessage（parts）。
//   - 主进程 streamText + toUIMessageStream 接入 buildAgentTools()，开启多步 Agent Loop。
//   - 发送前用户消息落盘；回复完成后在 onFinish 解析多工具意图并逐工具落盘。
//   - 会话历史、当前会话、多标签页三栏在 app.vue 组合；本 composable 只关心会话与聊天。

import { computed, ref, shallowRef, triggerRef, watchEffect, type ShallowRef } from 'vue'
import { useChat } from '@ai-sdk/vue'
import { isReasoningUIPart, isTextUIPart, type ChatInit, type UIMessage } from 'ai'
import { ElectronChatTransport } from '@/lib/custom-chat-transport'
import { parseGeneratedIntents } from '@/lib/tool-generator'
import type { GeneratedChangeList } from '@/lib/tool-generator'
import type {
  ApplyIntentEntryResult,
  Conversation,
  EditIntent,
  GeneratedIntent,
  Message
} from '../../../shared/types'

/** 自动落盘留痕：AI 产出变更清单后直接应用，卡片仅作留痕展示（无手动应用/放弃） */
export interface PendingChange {
  /** 对应消息的展示 id（即 UIMessage.id） */
  messageId: string
  changes: GeneratedChangeList
  /** 应用失败时的错误信息（status = failed 时展示） */
  error?: string
}

/** 会话历史列表项展示所需的时间格式化；补上分钟，便于同日内区分多次会话 */
export function formatSessionTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 主进程 Message → 渲染层 UIMessage。
 * 新数据带完整 parts（reasoning/text/tool），直接还原分轮思考与工具卡；
 * 旧数据无 parts，回退用 content+reasoning 重建（此时工具信息已在落盘时丢失，无法还原）。 */
function toUiMessage(m: Message): UIMessage {
  if (m.parts && m.parts.length) {
    return { id: m.id, role: m.role, parts: [...m.parts] }
  }
  const parts: UIMessage['parts'] = []
  if (m.reasoning) parts.push({ type: 'reasoning', text: m.reasoning })
  if (m.content) parts.push({ type: 'text', text: m.content })
  return { id: m.id, role: m.role, parts }
}

/** 由会话内全部 EditIntent 重建变更卡片：同一条 AI 消息只取第一个意图（主卡片），失败态回填 error */
function buildPendingMap(intents: EditIntent[]): Record<string, PendingChange> {
  const map: Record<string, PendingChange> = {}
  for (const intent of intents) {
    if (map[intent.messageId]) continue
    map[intent.messageId] = {
      messageId: intent.messageId,
      changes: { summary: intent.summary, actions: intent.actions },
      error: intent.status === 'failed' ? intent.error : undefined
    }
  }
  return map
}

// —— UIMessage 工具函数 ——
function extractText(message: UIMessage): string {
  return message.parts.filter(isTextUIPart).map((p) => p.text).join('')
}

function extractReasoning(message: UIMessage): string {
  return message.parts.filter(isReasoningUIPart).map((p) => p.text).join('')
}

/** 把消息气泡收敛为一段人性化摘要：非 text part（reasoning / tool）保留，正文收敛到末尾 text part。
 * 用于多工具意图契约 JSON → 总结文案，避免原始 JSON 直出气泡。
 * @param msgs 渲染层消息 ShallowRef，用于改动后触发布局刷新。 */
function setAssistantText(
  msgs: ShallowRef<UIMessage[]>,
  message: UIMessage,
  text: string
): void {
  const textParts = message.parts.filter(isTextUIPart)
  textParts.forEach((part, i) => {
    part.text = i === textParts.length - 1 ? text : ''
  })
  triggerRef(msgs)
}

export interface GlobalConversationOptions {
  /** 一次多工具改动成功应用后的回调（结果含每个工具的最新标题），用于同步标签名 / 重载工具详情 */
  onToolApplied?: (results: ApplyIntentEntryResult[]) => void
}

/**
 * 全局会话状态源。应在 app.vue 顶层调用一次，再把 state 下发给会话历史 / 当前会话两栏。
 */
export function useGlobalConversation(options: GlobalConversationOptions = {}) {
  // —— 会话列表（来自主进程，按 lastMessageAt 倒序由主进程保证）——
  const conversations = ref<Conversation[]>([])
  const activeConversationId = ref('')
  // —— 当前激活会话的变更卡片 ——
  const pendingMap = ref<Record<string, PendingChange>>({})

  // —— useChat：单个稳定 VueChat 实例；切换会话时直接重置 messages（ShallowRef 可安全赋值）——
  const transport = new ElectronChatTransport()
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
    chat.messages.value = []
    pendingMap.value = {}
    return conv.id
  }

  /** 加载某会话的消息与变更卡片并激活之 */
  async function activateConversation(id: string): Promise<void> {
    chat.stop()
    activeConversationId.value = id
    const [msgs, intents] = await Promise.all([
      window.api.conversation.messages(id),
      window.api.conversation.intents(id)
    ])
    chat.messages.value = msgs.map(toUiMessage)
    pendingMap.value = buildPendingMap(intents)
  }

  /** 初次加载会话列表：有则激活第一个，无则新建 */
  async function loadConversations(): Promise<void> {
    const list = await window.api.conversation.list()
    conversations.value = list
    if (list.length) {
      await activateConversation(list[0].id)
    } else {
      await ensureActiveConversation()
    }
  }

  /** 新建会话：立即在主进程创建并激活，清空当前视图 */
  async function newConversation(): Promise<void> {
    chat.stop()
    const conv = await window.api.conversation.create()
    conversations.value = [{ ...conv }, ...conversations.value]
    activeConversationId.value = conv.id
    chat.messages.value = []
    pendingMap.value = {}
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

  /** 清空全部会话：删除后新建一个空会话作为当前会话 */
  async function deleteAllConversations(): Promise<void> {
    chat.stop()
    await window.api.conversation.deleteAll()
    conversations.value = []
    activeConversationId.value = ''
    pendingMap.value = {}
    await ensureActiveConversation()
  }

  /** 把 AI 回复正文、思考过程与完整 parts 写入主进程会话，返回落盘消息 id（供 EditIntent 挂载） */
  async function persistAssistant(
    conversationId: string,
    content: string,
    reasoning?: string,
    parts?: UIMessage['parts']
  ): Promise<string | null> {
    // parts 可能来自响应式 message，直接经 contextBridge 传主进程不保险；先深拷贝为纯数据
    const cleanParts = parts ? (JSON.parse(JSON.stringify(parts)) as UIMessage['parts']) : undefined
    const msg = await window.api.conversation.appendMessage(
      conversationId,
      'assistant',
      content,
      reasoning,
      cleanParts
    )
    return msg?.id ?? null
  }

  /**
   * 应用多工具意图：调用 conversation:applyIntents 逐工具落盘并 git 提交。
   * 成功则回调 onToolApplied（同步标签名 / 重载详情）；失败把错误回填到留痕卡片。
   * cardMessageId 是渲染层展示 id（卡片 key），persistedMessageId 是主进程消息 id（EditIntent.messageId）。
   */
  async function applyIntents(
    conversationId: string,
    cardMessageId: string,
    persistedMessageId: string,
    intents: GeneratedIntent[]
  ): Promise<void> {
    const current = pendingMap.value[cardMessageId]
    try {
      // intents 可能来自响应式 ref，直接经 contextBridge 传主进程会触发 structured clone 报错，
      // 先做一次 JSON 深拷贝得到纯数据对象，再跨进程传递。
      const payload = JSON.parse(JSON.stringify({ intents })) as { intents: GeneratedIntent[] }
      const res = await window.api.conversation.applyIntents({
        conversationId,
        messageId: persistedMessageId,
        intents: payload.intents
      })
      // 卡片主意图取 intents[0]（send 不再附当前工具上下文），失败/成功以第一条结果为准
      const entry = res.results[0]
      const failed =
        entry && !entry.ok ? (entry.error ?? '未知错误') : res.ok ? null : (res.error ?? '未知错误')
      if (failed) {
        if (current) current.error = failed
        return
      }
      options.onToolApplied?.(res.results)
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error)
      console.error('[use-global-conversation] applyIntents 失败：', error)
      if (current) current.error = err
    }
  }

  /**
   * 回复完成回调（useChat onFinish）：解析多工具意图并逐工具落盘。
   * 若意图为契约 JSON，则把气泡收敛为 summary；否则原样展示正文。
   */
  async function handleChatFinish({
    message,
    isAbort
  }: {
    message: UIMessage
    isAbort: boolean
  }): Promise<void> {
    // 用户停止 / 切换会话后旧流的 finish 晚到：跳过落盘，避免残留半截消息
    if (isAbort) return
    if (!chat.messages.value.some((m) => m.id === message.id)) return

    const conversationId = activeConversationId.value
    if (!conversationId) return

    // 在 setAssistantText（会把气泡收敛为 summary，清空中间轮正文）之前，捕获完整 parts
    // 作为落盘数据，保证回显时能还原分轮思考 / 工具卡 / 多段正文，而不是只剩压扁的正文。
    const persistParts = JSON.parse(JSON.stringify(message.parts)) as UIMessage['parts']

    const reasoning = extractReasoning(message)
    const text = extractText(message)

    let displayContent = text
    let intents: GeneratedIntent[] | null = null

    if (text.trim()) {
      const parsed = parseGeneratedIntents(text)
      if (parsed.intents) {
        intents = parsed.intents
        const primary = intents[0]
        displayContent = primary?.summary?.trim() || '已生成对工具的改动并应用'
        pendingMap.value[message.id] = {
          messageId: message.id,
          changes: { summary: primary?.summary ?? '', actions: primary?.actions ?? [] }
        }
        setAssistantText(chat.messages, message, displayContent)
      } else if (parsed.summary) {
        // LLM 输出「无实际动作」的契约 JSON（多为澄清追问）：直达人性化 summary
        displayContent = parsed.summary
        setAssistantText(chat.messages, message, displayContent)
      }
    } else {
      // 兜底：模型只思考而无正文 / 返回空内容时，给消息补一段人类可读文案，避免空白气泡
      displayContent = '（模型未生成回复内容，请重试或换个说法）'
      setAssistantText(chat.messages, message, displayContent)
    }

    // 正文定稿后落盘 assistant 消息（含思考与完整 parts，供会话回显）；若声明了编辑意图则逐工具应用
    const assistantId = await persistAssistant(
      conversationId,
      displayContent,
      reasoning,
      persistParts
    )
    if (intents?.length) {
      await applyIntents(conversationId, message.id, assistantId ?? message.id, intents)
    }
  }

  /** 出错回调（useChat onError）：移除空副本站，避免残留空白气泡；恢复可输入 */
  function handleChatError(): void {
    const last = chat.messages.value[chat.messages.value.length - 1]
    if (last && last.role === 'assistant' && !extractText(last).trim()) {
      chat.messages.value = chat.messages.value.slice(0, -1)
    }
  }

  /** 发送：用户消息落盘 -> useChat 自动追加并触发传输 */
  async function send(text: string): Promise<void> {
    if (!text || streaming.value) return

    const conversationId = await ensureActiveConversation()

    // 用户消息：主进程落盘（本地视图由 useChat 自动追加）
    await window.api.conversation.appendMessage(conversationId, 'user', text)
    await chat.sendMessage({ text })
  }

  /** 停止生成（交由 useChat 停止流，经 transport 通知主进程 abort） */
  function stopGeneration(): void {
    chat.stop()
  }

  /** 取某条 AI 消息挂载的变更卡片（可能不存在，如自动模式或无变更） */
  function pendingOf(messageId: string): PendingChange | undefined {
    return pendingMap.value[messageId]
  }

  return {
    // 会话列表
    conversations,
    activeConversationId,
    // 当前会话视图
    messages,
    pendingMap,
    streaming,
    status,
    // 操作
    loadConversations,
    newConversation,
    activateConversation,
    deleteConversation,
    deleteAllConversations,
    send,
    stopGeneration,
    pendingOf,
    /** 会话历史项展示用：lastMessageAt → 本地时间字符串 */
    formatSessionTime
  }
}
