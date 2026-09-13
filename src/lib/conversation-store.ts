// 会话与消息持久化（IndexedDB），替换桌面版主进程的 conversation-store。
// 为什么不用 chrome.storage.local：会话消息写入频繁且体积增长快，IndexedDB 更适合；
// 且 side panel 与 workbench 标签页同源，可直接共享该库，无需经 background 中转。
//
// 语义对齐桌面版 `legacy/src/main/conversation-store.ts`：
//   1. 新会话标题为「新会话 N」，N 来自**自增序号**（不是「当前会话数 + 1」，
//      否则删掉一个会话再新建就会出现重号）；序号持久化在 chrome.storage.local。
//   2. **首条用户消息自动命名**：标题仍是默认「新会话 N」时，取消息内容前 20 字作标题。
//      这段逻辑必须留在 appendMessage 里（桌面版就在此处），它是唯一的触发点。
//   3. `renameConversation` trim 后为空则拒绝（不写空标题）。
//   4. conversation.totalTokens 由消息 usage **派生**，不落库（桌面版同样"仅用于列表展示"）。
//      派生而非累加：老数据、重新生成、消息删除都不会让显示值漂移。
import type { Conversation, ConversationSearchHit, Message } from '../shared/types'

const DB_NAME = 'duoling-chat'
const DB_VERSION = 1
const CONVERSATIONS = 'conversations'
const MESSAGES = 'messages'
/** 新会话序号（chrome.storage.local）：保证「新会话 N」不重号，清空会话时重置 */
const SEQ_KEY = 'conversationSeq'

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

/** 把消息正文压成单行片段（截断展示用） */
function truncateSnippet(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 下一个会话序号：自增并落盘（对应桌面版的 nextSeq） */
async function takeNextSeq(): Promise<number> {
  const raw = (await chrome.storage.local.get(SEQ_KEY))[SEQ_KEY] as number | undefined
  const seq = typeof raw === 'number' && raw > 0 ? raw : 1
  await chrome.storage.local.set({ [SEQ_KEY]: seq + 1 })
  return seq
}

// —— 会话 ——

/** 会话列表，按最后消息时间倒序（新在前）；每项附带由消息派生的 totalTokens */
export async function listConversations(): Promise<Conversation[]> {
  const { conversations, byConversation } = await readAll()
  return conversations
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
    .map((c) => ({ ...c, totalTokens: sumTokens(byConversation.get(c.id)) }))
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
    const transaction = db.transaction([CONVERSATIONS, MESSAGES], 'readwrite')
    transaction.objectStore(CONVERSATIONS).clear()
    transaction.objectStore(MESSAGES).clear()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  await chrome.storage.local.set({ [SEQ_KEY]: 1 })
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
 */
export async function appendMessage(message: Message): Promise<Message | null> {
  const existing = await listMessages(message.conversationId)
  await tx(MESSAGES, 'readwrite', (s) => s.put(message))
  const conversation = await tx<Conversation | undefined>(CONVERSATIONS, 'readonly', (s) =>
    s.get(message.conversationId),
  )
  if (!conversation) return null

  const next: Conversation = { ...conversation, lastMessageAt: message.createdAt }
  if (existing.length === 0 && message.role === 'user' && /^新会话 \d+$/.test(next.title)) {
    const trimmed = message.content.trim()
    if (trimmed) next.title = trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed
  }
  await tx(CONVERSATIONS, 'readwrite', (s) => s.put(next))
  return message
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
    .map((c) => ({ ...c, totalTokens: sumTokens(byConversation.get(c.id)) }))
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
