// duoling-chat：会话 / 消息 / meta（自增序号）/ 生成任务快照。
//
// 会话库的**唯一打开器**：连接一份、升级回调一份。
// 为什么必须唯一：tasks store 与会话同库（同一写方 offscreen），若两个模块各 open 一次，
// 同一库上就挂两条独立连接 —— 升级时各自处理 versionchange、各自缓存版本，一方 close
// 另一方还握着旧连接。
import { createIdbOpener, type IdbOpener } from '../idb-core'

export const CHAT_DB_NAME = 'duoling-chat'
/** v3：tasks store 并入（原独立库 duoling-chat-tasks，见 @duoling/offscreen-document 的 chat/task-store.ts） */
export const CHAT_DB_VERSION = 3
export const CHAT_CONVERSATIONS_STORE = 'conversations'
export const CHAT_MESSAGES_STORE = 'messages'
export const CHAT_META_STORE = 'meta'
/** 生成任务快照 store（chat-host 写，与 conversation 写侧同归 offscreen） */
export const TASKS = 'tasks'

let handle: IdbOpener | null = null

/** 惰性构造：模块求值期不做调用，否则打包器整块裁不掉本模块 */
export function getChatDb(): IdbOpener {
  return (handle ??= createIdbOpener({
    name: CHAT_DB_NAME,
    version: CHAT_DB_VERSION,
    label: '会话库',
    upgrade: (db) => {
      if (!db.objectStoreNames.contains(CHAT_CONVERSATIONS_STORE)) {
        const store = db.createObjectStore(CHAT_CONVERSATIONS_STORE, { keyPath: 'id' })
        store.createIndex('lastMessageAt', 'lastMessageAt')
      }
      if (!db.objectStoreNames.contains(CHAT_MESSAGES_STORE)) {
        const store = db.createObjectStore(CHAT_MESSAGES_STORE, { keyPath: 'id' })
        store.createIndex('conversationId', 'conversationId')
      }
      if (!db.objectStoreNames.contains(CHAT_META_STORE)) {
        db.createObjectStore(CHAT_META_STORE)
      }
      // v3：任务快照并入本库（原 duoling-chat-tasks 库）
      if (!db.objectStoreNames.contains(TASKS)) {
        db.createObjectStore(TASKS, { keyPath: 'taskId' })
      }
    },
  }))
}
