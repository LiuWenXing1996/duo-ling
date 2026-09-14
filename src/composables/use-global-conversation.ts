// 全局会话 composable：把「会话」从工具分桶（localStorage）提升为主进程一等公民的渲染层状态源。
//
// 布局上对应全局三栏中的「会话历史 + 当前会话」两栏：会话列表来自主进程 conversation-store，
// 消息全部持久化在主进程，此处只维护「当前激活会话」的视图与流式过程中的临时态。
//
// 方案 B（切进 AI SDK 全家桶）后的关键行为：
//   - 用 @ai-sdk/vue useChat({ transport }) 驱动整条对话链路，消息模型为 UIMessage（parts）。
//   - 主进程 streamText + toUIMessageStream 接入 buildAgentTools()，开启多步 Agent Loop。
//   - 发送前用户消息落盘；回复完成后在 onFinish 落盘 assistant 消息（含 parts 与 token 用量）。
//   - 会话历史、当前会话、多标签页三栏在 app.vue 组合；本 composable 只关心会话与聊天。
//
// 2026-09-14：工具链路移除（docs/tool-chain-removal-plan.md）后，原「多工具意图」分支
// （parseGeneratedIntents / applyIntents / 变更卡片 pendingMap / onToolApplied）整体摘除 ——
// 本文件只剩会话 CRUD + 流式 + token 统计，供「AI 生成用户脚本」复用同一条对话链路。

import { computed, ref, shallowRef, triggerRef, watchEffect, type ShallowRef } from 'vue'
import { useChat } from '@ai-sdk/vue'
import { isReasoningUIPart, isTextUIPart, type ChatInit, type UIMessage } from 'ai'
import { ExtensionChatTransport } from '@/lib/extension-chat-transport'
import type { Conversation, Message, TokenUsage } from '@/shared/types'

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

/**
 * 全局会话状态源。应在 app.vue 顶层调用一次，再把 state 下发给会话历史 / 当前会话两栏。
 */
export function useGlobalConversation() {
  // —— 会话列表（来自主进程，按 lastMessageAt 倒序由主进程保证）——
  const conversations = ref<Conversation[]>([])
  const activeConversationId = ref('')
  // —— 各消息本次消耗的 token（按 UIMessage.id 索引，供 ChatPanel 单条展示）——
  const usageByMessageId = ref<Record<string, TokenUsage>>({})

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
    chat.messages.value = []
    usageByMessageId.value = {}
    return conv.id
  }

  /** 加载某会话的消息并激活之 */
  async function activateConversation(id: string): Promise<void> {
    chat.stop()
    activeConversationId.value = id
    const msgs = await window.api.conversation.messages(id)
    chat.messages.value = msgs.map(toUiMessage)
    // 回读各消息已落盘的 token 用量，供单条展示（id 与 UIMessage.id 一致）
    const usageMap: Record<string, TokenUsage> = {}
    for (const m of msgs) {
      if (m.usage) usageMap[m.id] = m.usage
    }
    usageByMessageId.value = usageMap
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

  /** 重命名会话：调主进程 rename，成功后就地更新列表项（返回更新后的 Conversation） */
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
    usageByMessageId.value = {}
    chat.messages.value = []
  }

  /** 把 AI 回复正文、思考过程、完整 parts 与 token 用量写入主进程会话，返回落盘消息 id */
  async function persistAssistant(
    conversationId: string,
    content: string,
    reasoning?: string,
    parts?: UIMessage['parts'],
    usage?: TokenUsage
  ): Promise<string | null> {
    // parts 可能来自响应式 message，直接经 contextBridge 传主进程不保险；先深拷贝为纯数据
    const cleanParts = parts ? (JSON.parse(JSON.stringify(parts)) as UIMessage['parts']) : undefined
    const msg = await window.api.conversation.appendMessage(
      conversationId,
      'assistant',
      content,
      reasoning,
      cleanParts,
      usage
    )
    return msg?.id ?? null
  }

  /**
   * 回复完成回调（useChat onFinish）：落盘 assistant 消息（含完整 parts 与 token 用量）。
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

    // 读取本次生成的 token 用量（主进程 streamText onFinish 捕获，经 transport 透传到此）
    const usage = transport.getLastUsage()
    transport.clearUsage()
    if (usage) usageByMessageId.value = { ...usageByMessageId.value, [message.id]: usage }

    // 在可能改写气泡正文之前，捕获完整 parts 作为落盘数据，
    // 保证回显时能还原分轮思考 / 工具卡 / 多段正文，而不是只剩压扁的正文。
    const persistParts = JSON.parse(JSON.stringify(message.parts)) as UIMessage['parts']

    const reasoning = extractReasoning(message)
    const text = extractText(message)

    let displayContent = text
    if (!text.trim()) {
      // 兜底：模型只思考而无正文 / 返回空内容时，给消息补一段人类可读文案，避免空白气泡
      displayContent = '（模型未生成回复内容，请重试或换个说法）'
      setAssistantText(chat.messages, message, displayContent)
    }

    // 正文定稿后落盘 assistant 消息（含思考、完整 parts 与 token 用量，供会话回显/累计展示）
    await persistAssistant(conversationId, displayContent, reasoning, persistParts, usage)

    // 刷新会话列表（重新计算 totalTokens / lastMessageAt 排序），保持历史侧栏累计值实时
    conversations.value = await window.api.conversation.list()
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

    // 首条用户消息自动命名：新建会话（默认「新会话 N」标题）且本地无消息时，用消息内容前 20 字同步标题
    const conv = conversations.value.find((c) => c.id === conversationId)
    if (conv && chat.messages.value.length === 0 && /^新会话 \d+$/.test(conv.title)) {
      const t = text.trim()
      if (t) conv.title = t.length > 20 ? `${t.slice(0, 20)}…` : t
    }

    // 用户消息：主进程落盘（本地视图由 useChat 自动追加）
    await window.api.conversation.appendMessage(conversationId, 'user', text)
    await chat.sendMessage({ text })
  }

  /** 停止生成（交由 useChat 停止流，经 transport 通知主进程 abort） */
  function stopGeneration(): void {
    chat.stop()
  }

  return {
    // 会话列表
    conversations,
    activeConversationId,
    // 当前会话视图
    messages,
    /** 各消息本次消耗的 token（按 UIMessage.id 索引，供单条展示） */
    usageByMessageId,
    streaming,
    status,
    // 操作
    loadConversations,
    newConversation,
    activateConversation,
    deleteConversation,
    deleteAllConversations,
    renameConversation,
    send,
    stopGeneration,
    /** 会话历史项展示用：lastMessageAt → 本地时间字符串 */
    formatSessionTime
  }
}
