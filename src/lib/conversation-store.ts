// 会话与消息持久化（IndexedDB），替换桌面版主进程的 conversation-store。
// 为什么不用 chrome.storage.local：会话消息写入频繁且体积增长快，IndexedDB 更适合；
// 且 side panel / workbench / offscreen 同源，可直接共享该库，无需经 background 中转。
//
// **会话历史的唯一写入方 = offscreen**（侧边栏只读 + 订阅，防双写）。
// offscreen 只有 chrome.runtime，拿不到 chrome.storage —— 会话自增序号（SEQ）因此落在
// 本库的 meta store，取号在一个 readwrite 事务内完成（原子自增）。
//
// 语义对齐桌面版原实现（conversation-store）：
//   1. 新会话标题为「新会话 N」，N 来自**自增序号**（不是「当前会话数 + 1」，
//      否则删掉一个会话再新建就会出现重号）；序号持久化在本库 meta store。
//   2. **首条用户消息自动命名**：标题仍是默认「新会话 N」时，取消息内容前 20 字作标题。
//      这段逻辑必须留在 appendMessage 里（桌面版就在此处），它是唯一的触发点。
//   3. `renameConversation` trim 后为空则拒绝（不写空标题）。
//   4. conversation.totalTokens 由消息 usage **派生**，不落库（桌面版同样"仅用于列表展示"）。
//      派生而非累加：老数据、重新生成、消息删除都不会让显示值漂移。
import type { Conversation, ConversationSearchHit, Message } from '../shared/types'

const DB_NAME = 'duoling-chat'
const DB_VERSION = 2
const CONVERSATIONS = 'conversations'
const MESSAGES = 'messages'
const META = 'meta'
/** 新会话序号（meta store 键）：保证「新会话 N」不重号，清空会话时重置 */
const SEQ_META_KEY = 'conversationSeq'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(CONVERSATIONS)) {
        const store = db.createObjectStore(CONVERSATIONS, { keyPath: 'id' })
        store.createIndex('lastMessageAt', 'lastMessageAt')
      }
      if (!db.objectStoreNames.contains(MESSAGES)) {
        const store = db.createObjectStore(MESSAGES, { keyPath: 'id' })
        store.createIndex('conversationId', 'conversationId')
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode)
        const request = run(transaction.objectStore(storeName))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      }),
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

/** 会话 token 总量（由消息 usage 汇总，与桌面版 conversationTotalTokens 一致） */
function sumTokens(messages: Message[] | undefined): number {
  return (messages ?? []).reduce((sum, m) => sum + (m.usage?.totalTokens ?? 0), 0)
}

/** 为会话派生列表展示字段：累计 token + 最近一条消息预览（取消息组最后一条正文截断） */
function deriveConversation(c: Conversation, messages: Message[] | undefined): Conversation {
  const list = messages ?? []
  const last = list[list.length - 1]
  return {
    ...c,
    totalTokens: sumTokens(list),
    lastMessagePreview: last ? truncateSnippet(last.content, 80) : ''
  }
}

/** 把消息正文压成单行片段（截断展示用） */
function truncateSnippet(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 下一个会话序号：在**单个 readwrite 事务内**读旧值 + 写新值（原子自增，不靠跨事务读改写）。
 * 唯一写方是 offscreen（对话链路宿主）。
 */
async function takeNextSeq(): Promise<number> {
  const db = await openDb()
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction(META, 'readwrite')
    const store = tx.objectStore(META)
    const req = store.get(SEQ_META_KEY)
    req.onsuccess = () => {
      let seq = typeof req.result === 'number' && req.result > 0 ? req.result : 1
      store.put(seq + 1, SEQ_META_KEY)
      resolve(seq)
    }
    req.onerror = () => reject(req.error)
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
  return conversation
}

/** 重命名；标题 trim 后为空则拒绝（返回 null），与桌面版一致 */
export async function renameConversation(id: string, title: string): Promise<Conversation | null> {
  const trimmed = title.trim()
  if (!trimmed) return null
  const conversation = await tx<Conversation | undefined>(CONVERSATIONS, 'readonly', (s) => s.get(id))
  if (!conversation) return null
  const next = { ...conversation, title: trimmed }
  await tx(CONVERSATIONS, 'readwrite', (s) => s.put(next))
  return next
}

export async function deleteConversation(id: string): Promise<void> {
  const messages = await listMessages(id)
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([CONVERSATIONS, MESSAGES], 'readwrite')
    transaction.objectStore(CONVERSATIONS).delete(id)
    const messageStore = transaction.objectStore(MESSAGES)
    for (const m of messages) messageStore.delete(m.id)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

/** 清空全部会话与消息，并把序号重置回 1（下次新建从「新会话 1」开始） */
export async function deleteAllConversations(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([CONVERSATIONS, MESSAGES, META], 'readwrite')
    transaction.objectStore(CONVERSATIONS).clear()
    transaction.objectStore(MESSAGES).clear()
    transaction.objectStore(META).put(1, SEQ_META_KEY)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

// —— 消息 ——

export async function listMessages(conversationId: string): Promise<Message[]> {
  const index = await openDb().then((db) => {
    const transaction = db.transaction(MESSAGES, 'readonly')
    return transaction.objectStore(MESSAGES).index('conversationId')
  })
  const all = await new Promise<Message[]>((resolve, reject) => {
    const request = index.getAll(conversationId)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
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
 * 命名条件也由此改为「该会话此前没有用户消息」（而非「没有任何消息」）——
 * 异常收尾可能让 assistant 消息先落盘，按任意消息判断会让改名静默失效。
 */
export async function appendMessage(message: Message): Promise<Message | null> {
  const db = await openDb()
  return new Promise<Message | null>((resolve, reject) => {
    const transaction = db.transaction([CONVERSATIONS, MESSAGES], 'readwrite')
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
      const isFirstUserMessage = message.role === 'user' && !prior.some((m) => m.role === 'user')
      if (isFirstUserMessage && /^新会话 \d+$/.test(next.title)) {
        const trimmed = message.content.trim()
        if (trimmed) next.title = trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed
      }
      conversations.put(next)
    }
    transaction.oncomplete = () => resolve(convReq.result ? message : null)
    transaction.onerror = () => reject(transaction.error ?? new Error('appendMessage 事务失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('appendMessage 事务中止'))
  })
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
