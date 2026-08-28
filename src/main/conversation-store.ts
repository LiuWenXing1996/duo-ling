// 会话独立存储：把「会话」从工具会话（localStorage 分桶）提升为主进程一等公民。
//
// 数据模型（Phase 1·解耦与契约）：
//   Conversation —— 全局唯一的会话元信息（唯一关联工具的点是 EditIntent.toolId，会话本身不绑工具）
//   Message      —— 会话内一条消息（user/assistant）
//   EditIntent   —— 挂在某条 AI 消息下、对「某个工具」的一次编辑意图（多工具契约的持久化载体）
//
// 存储为 electron-store，JSON Schema 校验拒绝畸形数据。惰性创建，首次调用发生在 IPC 处理时
// （app 就绪且 userData 覆盖已生效之后），与 model-store 保持一致。

import Store, { type Schema } from 'electron-store'
import type {
  Conversation,
  ConversationSearchHit,
  EditIntent,
  EditIntentStatus,
  Message,
  MessageRole,
  ToolChangeAction
} from '../shared/types'

export type {
  Conversation,
  ConversationSearchHit,
  EditIntent,
  EditIntentStatus,
  Message,
  MessageRole,
  ToolChangeAction
}

interface ConversationState {
  conversations: Conversation[]
  // 自增序号：用于新会话标题「新会话 N」（会话列表展示与旧 task 语义兼容）
  nextSeq: number
  // 按 conversationId 分桶的消息
  messages: Record<string, Message[]>
  // 按 messageId 分桶的 EditIntent（一条 AI 消息可声明多个工具意图）
  intents: Record<string, EditIntent[]>
}

// JSON Schema 校验：拒绝畸形/被篡改的数据，防止损坏文件导致渲染层崩溃
const schema: Schema<ConversationState> = {
  conversations: {
    type: 'array',
    items: {
      type: 'object',
      required: ['id', 'title', 'createdAt', 'lastMessageAt'],
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        createdAt: { type: 'string' },
        lastMessageAt: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  nextSeq: { type: 'number' },
  messages: {
    type: 'object',
    additionalProperties: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'conversationId', 'role', 'content', 'createdAt'],
        properties: {
          id: { type: 'string' },
          conversationId: { type: 'string' },
          role: { type: 'string', enum: ['user', 'assistant'] },
          content: { type: 'string' },
          reasoning: { type: 'string' },
          // 完整 UIMessage.parts；宽松校验（仅要求数组，不深入 items），兼容旧数据缺省
          parts: { type: 'array' },
          // 本次生成消耗的 token 用量（仅 assistant 消息）；宽松校验，兼容旧数据缺省
          usage: {
            type: 'object',
            properties: {
              inputTokens: { type: 'number' },
              outputTokens: { type: 'number' },
              totalTokens: { type: 'number' }
            },
            additionalProperties: false
          },
          createdAt: { type: 'string' }
        },
        additionalProperties: false
      }
    }
  },
  intents: {
    type: 'object',
    additionalProperties: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'messageId', 'toolId', 'summary', 'actions', 'status', 'createdAt'],
        properties: {
          id: { type: 'string' },
          messageId: { type: 'string' },
          toolId: { type: 'string' },
          summary: { type: 'string' },
          actions: { type: 'array' },
          status: { type: 'string', enum: ['pending', 'applied', 'failed', 'rejected'] },
          error: { type: 'string' },
          createdAt: { type: 'string' }
        },
        additionalProperties: false
      }
    }
  }
}

let store: Store<ConversationState> | undefined

// 惰性创建：首次调用发生在 IPC 处理时（app 就绪且 userData 覆盖已生效之后）
function getStore(): Store<ConversationState> {
  store ??= new Store<ConversationState>({
    name: 'conversations',
    defaults: { conversations: [], nextSeq: 1, messages: {}, intents: {} },
    schema
  })
  return store
}

/** 生成足够唯一的 ID（前缀 + 时间戳 + 随机段），会话/消息/意图三种实体复用 */
function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 会话累计 token：汇总该会话全部消息 usage.totalTokens（旧数据无 usage 记 0） */
function conversationTotalTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + (m.usage?.totalTokens ?? 0), 0)
}

/** 会话列表，按最后消息时间倒序（新在前）；无消息会话按创建时间倒序。
 * 每项附带 totalTokens（由消息 usage 汇总，仅用于历史列表展示，不落库）。 */
export function listConversations(): Conversation[] {
  const store = getStore()
  const messageMap = store.get('messages')
  return [...store.get('conversations')]
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
    .map((c) => ({ ...c, totalTokens: conversationTotalTokens(messageMap[c.id] ?? []) }))
}

export function getConversation(id: string): Conversation | null {
  return getStore().get('conversations').find((c) => c.id === id) ?? null
}

/** 把消息正文压成单行片段（截断展示用） */
function truncateSnippet(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 搜索会话：空查询返回最近会话（limit 条，snippet 为空）；非空匹配会话标题或任意消息正文
 * （大小写不敏感），snippet 取第一条命中消息的正文片段。
 */
export function searchConversations(query: string, limit = 20): ConversationSearchHit[] {
  const q = query.trim().toLowerCase()
  const sorted = listConversations()
  if (!q) {
    return sorted.slice(0, limit).map((conversation) => ({ conversation, snippet: '' }))
  }
  const messages = getStore().get('messages')
  const out: ConversationSearchHit[] = []
  for (const conversation of sorted) {
    if (out.length >= limit) break
    let snippet = ''
    let hit = conversation.title.toLowerCase().includes(q)
    for (const m of messages[conversation.id] ?? []) {
      if (m.content && m.content.toLowerCase().includes(q)) {
        snippet = m.content
        hit = true
        break
      }
    }
    if (hit) out.push({ conversation, snippet: truncateSnippet(snippet) })
  }
  return out
}

export function createConversation(): Conversation {
  const seq = getStore().get('nextSeq')
  getStore().set('nextSeq', seq + 1)
  const now = new Date().toISOString()
  const conversation: Conversation = {
    id: newId('c'),
    title: `新会话 ${seq}`,
    createdAt: now,
    lastMessageAt: now
  }
  const list = getStore().get('conversations')
  getStore().set('conversations', [...list, conversation])
  return conversation
}

/** 重命名会话（手动改名或首条消息自动命名）；title 去空白，为空返回 null */
export function renameConversation(id: string, title: string): Conversation | null {
  const trimmed = title.trim()
  if (!trimmed) return null
  const list = getStore().get('conversations')
  const index = list.findIndex((c) => c.id === id)
  if (index === -1) return null
  const next = [...list]
  next[index] = { ...next[index], title: trimmed }
  getStore().set('conversations', next)
  return next[index]
}

export function listMessages(conversationId: string): Message[] {
  return getStore().get('messages')[conversationId] ?? []
}

/** 取出某会话全部消息名下登记的编辑意图（重建变更卡片用） */
export function listConversationIntents(conversationId: string): EditIntent[] {
  const intents = getStore().get('intents')
  const out: EditIntent[] = []
  for (const m of listMessages(conversationId)) {
    const list = intents[m.id]
    if (list) out.push(...list)
  }
  return out
}

/** appendMessage 的 usage 入参（兼容 Message.usage 片段，避免主进程与 store 强耦合到完整类型） */
type AppendUsage = Message['usage']

/** 追加一条消息并刷新会话 lastMessageAt；返回落库后的消息（reasoning/parts/usage 仅 assistant 消息传入） */
export function appendMessage(
  conversationId: string,
  role: MessageRole,
  content: string,
  reasoning?: string,
  parts?: Message['parts'],
  usage?: AppendUsage
): Message | null {
  const conversation = getConversation(conversationId)
  if (!conversation) return null
  const now = new Date().toISOString()
  const message: Message = {
    id: newId('m'),
    conversationId,
    role,
    content,
    reasoning,
    parts,
    usage,
    createdAt: now
  }
  const messages = getStore().get('messages')
  const current = messages[conversationId] ?? []
  getStore().set('messages', { ...messages, [conversationId]: [...current, message] })
  // 刷新会话最后消息时间，保证会话列表排序正确
  const list = getStore().get('conversations')
  const index = list.findIndex((c) => c.id === conversationId)
  if (index !== -1) {
    const nextList = [...list]
    const next = { ...nextList[index], lastMessageAt: now }
    // 首条用户消息自动命名：标题仍为默认「新会话 N」时，用消息内容前 20 字作会话名
    if (current.length === 0 && role === 'user' && /^新会话 \d+$/.test(next.title)) {
      const trimmed = content.trim()
      if (trimmed) {
        next.title = trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed
      }
    }
    nextList[index] = next
    getStore().set('conversations', nextList)
  }
  return message
}

/** 取出某条 AI 消息下声明的全部编辑意图 */
export function listIntents(messageId: string): EditIntent[] {
  return getStore().get('intents')[messageId] ?? []
}

/** 为某条 AI 消息登记一个编辑意图，返回落库后的意图 */
export function addIntent(
  messageId: string,
  toolId: string,
  summary: string,
  actions: ToolChangeAction[],
  status: EditIntentStatus = 'pending'
): EditIntent {
  const intent: EditIntent = {
    id: newId('i'),
    messageId,
    toolId,
    summary,
    actions,
    status,
    createdAt: new Date().toISOString()
  }
  const intents = getStore().get('intents')
  const current = intents[messageId] ?? []
  getStore().set('intents', { ...intents, [messageId]: [...current, intent] })
  return intent
}

/** 更新某条编辑意图的状态（applied / failed / rejected）；不存在则忽略 */
export function setIntentStatus(intentId: string, status: EditIntentStatus, error?: string): void {
  const intents = getStore().get('intents')
  const next: Record<string, EditIntent[]> = {}
  let changed = false
  for (const [messageId, list] of Object.entries(intents)) {
    const idx = list.findIndex((i) => i.id === intentId)
    if (idx === -1) {
      next[messageId] = list
      continue
    }
    const updated = [...list]
    updated[idx] = { ...updated[idx], status, ...(error ? { error } : {}) }
    next[messageId] = updated
    changed = true
  }
  if (changed) getStore().set('intents', next)
}

/** 删除单个会话，并清理其消息桶与该会话下所有消息的意图桶 */
export function deleteConversation(id: string): void {
  const store = getStore()
  const conversations = store.get('conversations').filter((c) => c.id !== id)
  store.set('conversations', conversations)

  const messages = store.get('messages')
  const { [id]: _removedMessages, ...restMessages } = messages
  if (messages[id]) store.set('messages', restMessages)

  // 清理该会话所有消息名下登记的意图（intents 按 messageId 分桶，需逐个判断归属）
  const messageIds = new Set((_removedMessages ?? []).map((m) => m.id))
  const intents = store.get('intents')
  const restIntents: Record<string, EditIntent[]> = {}
  for (const [messageId, list] of Object.entries(intents)) {
    if (!messageIds.has(messageId)) restIntents[messageId] = list
  }
  store.set('intents', restIntents)
}

/** 清空全部会话（连同消息与意图桶一并删除），序号重置回 1，下次新建从「新会话 1」开始 */
export function deleteAllConversations(): void {
  const store = getStore()
  store.set('conversations', [])
  store.set('messages', {})
  store.set('intents', {})
  store.set('nextSeq', 1)
}
