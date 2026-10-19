// 端测直接读会话库（duoling-chat）：会话与消息的读侧本来就是裸 IndexedDB。
// 页面里不再有全局 api 门面，测试读一行数据也不该为此开关 UI。
import type { Page } from '@playwright/test'

/** 会话条数（conversations store 的 count；库还没建起来时算 0） */
export async function countConversations(page: Page): Promise<number> {
  return await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('duoling-chat')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      // 面板尚未读写过会话库时，这里打开的是新建的空库
      if (!db.objectStoreNames.contains('conversations')) return 0
      return await new Promise<number>((resolve, reject) => {
        const req = db.transaction('conversations', 'readonly').objectStore('conversations').count()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  })
}

/** 最近一条会话里 assistant 消息的 totalTokens（没有则 0） */
export async function readAssistantTotalTokens(page: Page): Promise<number> {
  return await page.evaluate(async () => {
    interface Msg {
      role: string
      usage?: { totalTokens?: number }
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('duoling-chat')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      if (!db.objectStoreNames.contains('messages')) return 0
      // 两次独立事务：await 之间事务会提交，同一事务里连发两个请求会撞 TransactionInactive
      const read = async <T>(store: string, run: (s: IDBObjectStore) => IDBRequest): Promise<T> =>
        await new Promise<T>((resolve, reject) => {
          const req = run(db.transaction(store, 'readonly').objectStore(store))
          req.onsuccess = () => resolve(req.result as T)
          req.onerror = () => reject(req.error)
        })
      const conversations = await read<Array<{ id: string }>>('conversations', (s) => s.getAll())
      if (!conversations.length) return 0
      const messages = await read<Msg[]>('messages', (s) =>
        s.index('conversationId').getAll(conversations[0]!.id),
      )
      return messages.find((m) => m.role === 'assistant')?.usage?.totalTokens ?? 0
    } finally {
      db.close()
    }
  })
}
