// 全局会话 composable：把「会话」从工具分桶（localStorage）提升为主进程一等公民的渲染层状态源。
//
// 布局上对应全局三栏中的「会话历史 + 当前会话」两栏：会话列表来自主进程 conversation-store，
// 消息与 EditIntent 全部持久化在主进程，此处只维护「当前激活会话」的视图与流式过程中的临时态。
//
// 关键行为：
//   - send 不带工具上下文（agent.send(history) 缺省 context）：AI 在无 context 时
//     会提示「需明确指定 toolId」，由 intents[] 显式声明要改哪些工具。
//   - 每次发送自动落盘：user 消息 + assistant 消息写入主进程会话，多工具意图经
//     conversation:applyIntents 逐工具应用并留痕。
//   - 会话历史、当前会话、多标签页三栏在 app.vue 组合；本 composable 只关心会话与聊天。

import { ref } from 'vue'
import { parseGeneratedIntents } from '@/lib/tool-generator'
import type { GeneratedChangeList } from '@/lib/tool-generator'
import type {
  ApplyIntentEntryResult,
  Conversation,
  EditIntent,
  GeneratedIntent,
  AgentEventData,
  Message
} from '../../../shared/types'

// —— 渲染层聊天消息类型（与主进程 Message 不同：role 用 ai/user，含流式/思考/步骤）——
/** AI 自主调用工具的一个步骤（Agent Loop 逐步展示，对应「搜索/引用」样式） */
export interface ToolChatStep {
  id: string
  name: string
  arguments: string
  status: 'running' | 'done' | 'error'
  result?: string
  error?: string
  /** 触发该工具调用前，模型在本轮输出的正文（中间轮正文，归入步骤而非主消息气泡） */
  content?: string
}

export interface ToolChatMessage {
  id: string
  role: 'ai' | 'user'
  content: string
  /** AI 的思考过程（reasoning），与 content 分离存（可选；流式时作为「当前轮」临时累积） */
  reasoning?: string
  /** AI 每轮思考的按序列表（链上按轮分批展示；最终轮收尾时并入。历史回显时为空，回退用 reasoning） */
  reasonings?: string[]
  /** AI 自主调用工具的步骤列表（仅 AI 消息，由 tool_start/tool_result 事件累积；可选） */
  steps?: ToolChatStep[]
}

/** 自动落盘留痕：AI 产出变更清单后直接应用，卡片仅作留痕展示（无手动应用/放弃） */
export interface PendingChange {
  /** 对应消息的展示 id（即 ToolChatMessage.id） */
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

/** 主进程 Message → 渲染层 ToolChatMessage（role 归一化：assistant → ai；reasoning 原样带回显） */
function toChatMessage(m: Message): ToolChatMessage {
  return {
    id: m.id,
    role: m.role === 'assistant' ? 'ai' : 'user',
    content: m.content,
    reasoning: m.reasoning
  }
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
  // —— 当前激活会话的视图 ——
  const messages = ref<ToolChatMessage[]>([])
  const pendingMap = ref<Record<string, PendingChange>>({})
  // —— 流式过程中的临时态（不落盘）——
  const streaming = ref(false)
  const draft = ref<ToolChatMessage | null>(null)

  let ownsAgentListener = false

  /** 确保有当前激活会话：无则新建一个（首次进入 / 全部删除后）。返回会话 id。 */
  async function ensureActiveConversation(): Promise<string> {
    if (activeConversationId.value) return activeConversationId.value
    const conv = await window.api.conversation.create()
    conversations.value = [conv, ...conversations.value]
    activeConversationId.value = conv.id
    messages.value = []
    pendingMap.value = {}
    return conv.id
  }

  /** 加载某会话的消息与变更卡片并激活之 */
  async function activateConversation(id: string): Promise<void> {
    activeConversationId.value = id
    draft.value = null
    const [msgs, intents] = await Promise.all([
      window.api.conversation.messages(id),
      window.api.conversation.intents(id)
    ])
    messages.value = msgs.map(toChatMessage)
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
    draft.value = null
    const conv = await window.api.conversation.create()
    conversations.value = [{ ...conv }, ...conversations.value]
    activeConversationId.value = conv.id
    messages.value = []
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
    } else {
      draft.value = null
    }
  }

  /** 清空全部会话：删除后新建一个空会话作为当前会话 */
  async function deleteAllConversations(): Promise<void> {
    await window.api.conversation.deleteAll()
    conversations.value = []
    messages.value = []
    pendingMap.value = {}
    draft.value = null
    await ensureActiveConversation()
  }

  // —— AI 对话流式事件：把增量累积到草案消息，同时把 Agent Loop 工具调用累积到 steps ——
  function onAgentEvent(payload: AgentEventData): void {
    if (!draft.value) return
    if (payload.type === 'token') {
      draft.value.content += payload.token
      return
    }
    if (payload.type === 'reasoning') {
      if (!draft.value.reasoning) draft.value.reasoning = ''
      draft.value.reasoning += payload.text
      return
    }
    if (payload.type === 'tool_start') {
      // 本轮模型在调用工具前可能先输出了一段「思考」：把它从草稿的当前轮临时累积中归档到
      // reasonings（按轮分批展示），避免多轮思考在链首被聚合成一大段。
      if (!draft.value.reasonings) draft.value.reasonings = []
      draft.value.reasonings.push(draft.value.reasoning ?? '')
      draft.value.reasoning = ''
      // 同理，本轮正文也从草稿正文抽出、归为该步骤的说明，避免多轮正文在最终气泡里被拼接。
      const roundRaw = draft.value.content
      const roundContent = roundRaw.trim() ? roundRaw : ''
      if (roundContent) draft.value.content = ''
      if (!draft.value.steps) draft.value.steps = []
      draft.value.steps.push({
        id: `t-${draft.value.steps.length}-${Date.now()}`,
        name: payload.name,
        arguments: payload.arguments,
        status: 'running',
        content: roundContent || undefined
      })
      return
    }
    if (payload.type === 'tool_result') {
      const target = [...(draft.value.steps ?? [])]
        .reverse()
        .find((s) => s.name === payload.name && s.status === 'running')
      if (target) {
        target.status = payload.ok ? 'done' : 'error'
        target.result = payload.result
        target.error = payload.error
      }
    }
  }

  /** 把 AI 回复正文与思考过程写入主进程会话，返回落盘消息 id（供 EditIntent 挂载） */
  async function persistAssistant(
    conversationId: string,
    content: string,
    reasoning?: string
  ): Promise<string | null> {
    const msg = await window.api.conversation.appendMessage(
      conversationId,
      'assistant',
      content,
      reasoning
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

  /** 兜底：模型只思考而无正文 / 返回空内容时，给消息补一段人类可读文案，避免空白气泡 */
  function ensureNonEmptyAnswer(msg: ToolChatMessage): void {
    if (msg.content.trim()) return
    msg.content = '（模型未生成回复内容，请重试或换个说法）'
  }

  /** 发送：加入用户消息 -> 流式调用生成器（不带工具上下文）-> 解析多工具意图并逐工具落盘 */
  async function send(text: string): Promise<void> {
    if (!text || streaming.value) return

    const conversationId = await ensureActiveConversation()

    // 用户消息：本地视图 + 主进程落盘
    const userMsg: ToolChatMessage = { id: `u-${Date.now()}`, role: 'user', content: text }
    messages.value.push(userMsg)
    await window.api.conversation.appendMessage(conversationId, 'user', text)

    // 生成器要求最后一条为用户消息；把 ai 映射为 assistant
    const history = messages.value.map((m) => ({
      role: (m.role === 'ai' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: m.content
    }))

    const draftMsg: ToolChatMessage = { id: `a-${Date.now()}`, role: 'ai', content: '' }
    messages.value.push(draftMsg)
    draft.value = draftMsg
    streaming.value = true
    // 开始生成即接管全局单例监听器（全局只此一个监听者，生成结束 finally 归还）
    window.api.agent.onEvent(onAgentEvent)
    ownsAgentListener = true

    try {
      const res = await window.api.agent.send(history)
      // 最终轮思考收尾：并入 reasonings（链上按轮分批展示），reasoning 仍保留供历史回显回退
      if (res.reasoning) {
        if (!draftMsg.reasonings) draftMsg.reasonings = []
        draftMsg.reasonings.push(res.reasoning)
        draftMsg.reasoning = res.reasoning
      }

      let intents: GeneratedIntent[] | null = null
      if (res.content) {
        draftMsg.content = res.content
        const parsed = parseGeneratedIntents(res.content)
        if (parsed.intents) {
          intents = parsed.intents
          // 有实际改动：正文不再直出契约 JSON，改用第一个意图的 summary 作为人类可读回复
          const primary = intents[0]
          draftMsg.content = primary?.summary?.trim() || '已生成对工具的改动并应用'
          pendingMap.value[draftMsg.id] = {
            messageId: draftMsg.id,
            changes: { summary: primary?.summary ?? '', actions: primary?.actions ?? [] }
          }
        } else if (parsed.summary) {
          // LLM 输出「无实际动作」的契约 JSON（多为澄清追问）：直达人性化 summary
          draftMsg.content = parsed.summary
        } else {
          // 普通对话（打招呼/闲聊）：无可应用变更，正文非空则原样展示，空则兜底
          ensureNonEmptyAnswer(draftMsg)
        }
      } else if (res.error) {
        messages.value = messages.value.filter((m) => m.id !== draftMsg.id)
        return
      } else {
        ensureNonEmptyAnswer(draftMsg)
      }

      // 正文定稿后落盘 assistant 消息（含思考过程，供会话回显）；若声明了编辑意图则逐工具应用
      const assistantId = await persistAssistant(conversationId, draftMsg.content, draftMsg.reasoning)
      if (intents?.length) {
        await applyIntents(conversationId, draftMsg.id, assistantId ?? draftMsg.id, intents)
      }
    } catch (error) {
      messages.value = messages.value.filter((m) => m.id !== draftMsg.id)
    } finally {
      draft.value = null
      streaming.value = false
      if (ownsAgentListener) {
        window.api.agent.offEvent()
        ownsAgentListener = false
      }
    }
  }

  /** 停止生成（交由主进程 abort） */
  async function stopGeneration(): Promise<void> {
    await window.api.agent.abort()
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
    draft,
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
