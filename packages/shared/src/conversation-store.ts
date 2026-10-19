// 会话与消息持久化（IndexedDB）。为什么不用 chrome.storage.local：消息写入频繁且体积增长快，
// 且 side panel / workbench / offscreen 同源可直连该库，无需经 background 中转。
// **唯一写入方 = offscreen**（对话界面只读 + 订阅，防双写）；序号取号在本库 meta store 的
// 一个 readwrite 事务内原子自增。语义要点（自增序号 / 首条自动命名 / 空标题拒绝 /
// totalTokens 派生）与广播埋点理由，见 ARCHITECTURE.md「存储」节的会话库。
import type { Conversation, ConversationSearchHit, Message } from './conversation'
import { isAssetPart } from './chat-assets'
import { broadcastDataChange } from './data-broadcast-runtime'
import { idbRequest, idbRunTx } from './idb-core'
import {
  CHAT_CONVERSATIONS_STORE as CONVERSATIONS,
  CHAT_MESSAGES_STORE as MESSAGES,
  CHAT_META_STORE as META,
  getChatDb,
} from './db'

/** 新会话序号（meta store 键）：保证「新会话 N」不重号，清空会话时重置 */
const SEQ_META_KEY = 'conversationSeq'

/** 单 store 上的一次请求读写（事务级错误与死连接重试由 idbRunTx 兜） */
function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return idbRunTx(getChatDb(), storeName, mode, (transaction) =>
    idbRequest(run(transaction.objectStore(storeName))),
  )
}

/** 一次读出全部会话与消息（消息按会话分组），供列表与检索共用，避免 N 次往返 */
async function readAll(): Promise<{
  conversations: Conversation[]
  byConversation: Map<string, Message[]>
}> {
  const [conversations, messages] = await Promise.all([
    tx<Conversation[]>(CONVERSATIONS, 'readonly', (s) => s.getAll()),
    tx<Message[]>(MESSAGES, 'readonly', (s) => s.getAll()),
  ])
  const byConversation = new Map<string, Message[]>()
  for (const m of messages) {
    const list = byConversation.get(m.conversationId)
    if (list) list.push(m)
    else byConversation.set(m.conversationId, [m])
  }
  for (const list of byConversation.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  return { conversations, byConversation }
}

/** 会话 token 总量（由消息 usage 汇总，与桌面版 conversationTotalTokens 一致）。
 * Message 按 role 判别：usage 只属于 assistant 分支，读之前必须判角色。 */
function sumTokens(messages: Message[] | undefined): number {
  return (messages ?? []).reduce(
    (sum, m) => sum + (m.role === 'assistant' ? (m.usage?.totalTokens ?? 0) : 0),
    0,
  )
}

/** 为会话派生列表展示字段：累计 token + 最近一条消息预览（取消息组最后一条正文截断） */
function deriveConversation(c: Conversation, messages: Message[] | undefined): Conversation {
  const list = messages ?? []
  const last = list[list.length - 1]
  return {
    ...c,
    totalTokens: sumTokens(list),
    lastMessagePreview: last ? previewOf(last) : '',
  }
}

/** 把消息正文压成单行片段（截断展示用） */
function truncateSnippet(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 列表预览：正文空但带图片引用时给个可读占位 —— 只发了图的那条消息，预览不该是一片空白 */
function previewOf(m: Message): string {
  const text = truncateSnippet(m.content, 80)
  if (text) return text
  return (m.parts ?? []).some(isAssetPart) ? '[图片]' : ''
}

/**
 * 全库**还在被引用**的资源 id（消息里 `data-asset` 那份引用的全体）。
 *
 * 用途只有一个：删会话时算「哪些图片从此没人要了」——图片按内容 hash 存、可被多条会话共用，
 * 所以判据必须是「删完之后全库还剩谁在引用」，而不是「被删那条消息带过什么」。
 * 归属口径只有这一处（资源库只管删、不做引用判断）。
 */
export async function referencedAssetIds(): Promise<Set<string>> {
  const { byConversation } = await readAll()
  const ids = new Set<string>()
  for (const list of byConversation.values()) {
    for (const m of list) {
      for (const p of m.parts ?? []) {
        if (isAssetPart(p)) ids.add(p.data.id)
      }
    }
  }
  return ids
}

/**
 * 下一个会话序号：在**单个 readwrite 事务内**读旧值 + 写新值（原子自增，不靠跨事务读改写）。
 * 唯一写方是 offscreen（对话链路宿主）。
 */
async function takeNextSeq(): Promise<number> {
  return idbRunTx(getChatDb(), META, 'readwrite', (transaction) => {
    const store = transaction.objectStore(META)
    return new Promise<number>((resolve, reject) => {
      const req = store.get(SEQ_META_KEY)
      req.onsuccess = () => {
        const seq = typeof req.result === 'number' && req.result > 0 ? req.result : 1
        store.put(seq + 1, SEQ_META_KEY)
        resolve(seq)
      }
      req.onerror = () => reject(req.error ?? new Error('会话序号读取失败'))
    })
  })
}

// —— 会话 ——

/** 会话列表，按最后消息时间倒序（新在前）；每项附带由消息派生的 totalTokens / lastMessagePreview */
export async function listConversations(): Promise<Conversation[]> {
  const { conversations, byConversation } = await readAll()
  return conversations
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
    .map((c) => deriveConversation(c, byConversation.get(c.id)))
}

/** 新建会话，标题沿用桌面版的「新会话 N」格式（自动命名逻辑依赖该格式判断） */
export async function createConversation(): Promise<Conversation> {
  const seq = await takeNextSeq()
  const now = new Date().toISOString()
  const conversation: Conversation = {
    id: crypto.randomUUID(),
    title: `新会话 ${seq}`,
    createdAt: now,
    lastMessageAt: now,
  }
  await tx(CONVERSATIONS, 'readwrite', (s) => s.put(conversation))
  broadcastDataChange('conversation', conversation.id)
  return conversation
}

/** 重命名；标题 trim 后为空则拒绝（返回 null），与桌面版一致 */
export async function renameConversation(id: string, title: string): Promise<Conversation | null> {
  const trimmed = title.trim()
  if (!trimmed) return null
  const conversation = await tx<Conversation | undefined>(CONVERSATIONS, 'readonly', (s) =>
    s.get(id),
  )
  if (!conversation) return null
  const next = { ...conversation, title: trimmed }
  await tx(CONVERSATIONS, 'readwrite', (s) => s.put(next))
  broadcastDataChange('conversation', id)
  return next
}

export async function deleteConversation(id: string): Promise<void> {
  const messages = await listMessages(id)
  await idbRunTx(
    getChatDb(),
    [CONVERSATIONS, MESSAGES],
    'readwrite',
    (transaction) =>
      new Promise<void>((resolve, reject) => {
        transaction.objectStore(CONVERSATIONS).delete(id)
        const messageStore = transaction.objectStore(MESSAGES)
        for (const m of messages) messageStore.delete(m.id)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('删除会话失败'))
      }),
  )
  broadcastDataChange('conversation', id)
}

/** 清空全部会话与消息，并把序号重置回 1（下次新建从「新会话 1」开始） */
export async function deleteAllConversations(): Promise<void> {
  await idbRunTx(
    getChatDb(),
    [CONVERSATIONS, MESSAGES, META],
    'readwrite',
    (transaction) =>
      new Promise<void>((resolve, reject) => {
        transaction.objectStore(CONVERSATIONS).clear()
        transaction.objectStore(MESSAGES).clear()
        transaction.objectStore(META).put(1, SEQ_META_KEY)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('清空会话失败'))
      }),
  )
  broadcastDataChange('conversation') // 无 uuid = 全量变化
}

// —— 消息 ——

export async function listMessages(conversationId: string): Promise<Message[]> {
  const all = await idbRunTx(getChatDb(), MESSAGES, 'readonly', (transaction) =>
    idbRequest<Message[]>(
      transaction.objectStore(MESSAGES).index('conversationId').getAll(conversationId),
    ),
  )
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/**
 * 追加一条消息并刷新会话 lastMessageAt；会话不存在时返回 null（与桌面版一致）。
 * 顺带处理**首条用户消息自动命名**——桌面版把这段逻辑放在同一处，是唯一的触发点，
 * 拆出去（例如做成独立的 autoTitle 供外部调用）会因无人调用而静默失效。
 *
 * 必须在**单个 readwrite 事务**里完成读与写：拆成多个独立事务（查 existing → 写消息 →
 * 读+写会话）时，两个 append 并发交错会让后提交的用读到的旧标题覆盖先完成的自动命名
 * （部分会话标题会停在「新会话 N」）。
 * 命名条件是「该会话尚无用户消息」（而非「没有任何消息」）——
 * 异常收尾可能让 assistant 消息先落盘，按任意消息判断会让改名静默失效。
 */
export async function appendMessage(message: Message): Promise<Message | null> {
  return idbRunTx(
    getChatDb(),
    [CONVERSATIONS, MESSAGES],
    'readwrite',
    (transaction) =>
      new Promise<Message | null>((resolve, reject) => {
        const messages = transaction.objectStore(MESSAGES)
        const conversations = transaction.objectStore(CONVERSATIONS)

        // 请求按发出顺序执行：先读会话与既有消息，回调里再做写入（同事务，不会提前提交）
        const convReq = conversations.get(message.conversationId)
        const listReq = messages.index('conversationId').getAll(message.conversationId)
        listReq.onsuccess = () => {
          const conversation = convReq.result as Conversation | undefined
          if (!conversation) return // 会话不存在：不写任何东西，oncomplete 时 resolve null

          messages.put(message)
          const prior = listReq.result as Message[]
          const next: Conversation = { ...conversation, lastMessageAt: message.createdAt }
          const isFirstUserMessage =
            message.role === 'user' && !prior.some((m) => m.role === 'user')
          if (isFirstUserMessage && /^新会话 \d+$/.test(next.title)) {
            const trimmed = message.content.trim()
            if (trimmed) next.title = trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed
          }
          conversations.put(next)
        }
        transaction.oncomplete = () => {
          const existed = Boolean(convReq.result)
          // 会话不存在时上面什么都没写，不该让前端白拉一次——只在真的落盘后才广播
          if (existed) broadcastDataChange('conversation', message.conversationId)
          resolve(existed ? message : null)
        }
        transaction.onerror = () => reject(transaction.error ?? new Error('写入消息失败'))
        transaction.onabort = () => reject(transaction.error ?? new Error('写入消息被中止'))
      }),
  )
}

/** 会话检索：空查询返回最近 limit 条；非空匹配标题或任意消息正文（大小写不敏感） */
export async function searchConversations(
  query: string,
  limit = 20,
): Promise<ConversationSearchHit[]> {
  const q = query.trim().toLowerCase()
  const { conversations, byConversation } = await readAll()
  const sorted = conversations
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
    .map((c) => deriveConversation(c, byConversation.get(c.id)))
  if (!q) return sorted.slice(0, limit).map((conversation) => ({ conversation, snippet: '' }))

  const hits: ConversationSearchHit[] = []
  for (const conversation of sorted) {
    if (hits.length >= limit) break
    if (conversation.title.toLowerCase().includes(q)) {
      hits.push({ conversation, snippet: '' })
      continue
    }
    const hit = (byConversation.get(conversation.id) ?? []).find((m) =>
      m.content.toLowerCase().includes(q),
    )
    if (hit) {
      hits.push({ conversation, snippet: truncateSnippet(hit.content) })
    }
  }
  return hits
}
