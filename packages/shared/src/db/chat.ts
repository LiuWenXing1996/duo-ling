// duoling-chat：会话 / 消息 / meta（自增序号）/ 生成任务快照。
import Dexie, { type Table } from 'dexie'
import type { Conversation, Message } from '../conversation'
import type { ChatTaskRecord } from '../chat-task'

export const CHAT_DB_NAME = 'duoling-chat'
export const CHAT_DB_VERSION = 3
export const CHAT_CONVERSATIONS_STORE = 'conversations'
export const CHAT_MESSAGES_STORE = 'messages'
export const CHAT_META_STORE = 'meta'
/** 生成任务快照 store（chat-host 写，与 conversation 写侧同归 offscreen） */
export const TASKS = 'tasks'

interface ChatDbTables {
  conversations: Table<Conversation, string>
  messages: Table<Message, string>
  meta: Table<unknown, string>
  tasks: Table<ChatTaskRecord, string>
}

class ChatDb extends Dexie implements ChatDbTables {
  conversations!: Table<Conversation, string>
  messages!: Table<Message, string>
  meta!: Table<unknown, string>
  tasks!: Table<ChatTaskRecord, string>

  constructor() {
    super(CHAT_DB_NAME)
    this.version(CHAT_DB_VERSION).stores({
      [CHAT_CONVERSATIONS_STORE]: 'id, lastMessageAt',
      [CHAT_MESSAGES_STORE]: 'id, conversationId',
      [CHAT_META_STORE]: '',
      [TASKS]: 'taskId',
    })
  }
}

let handle: ChatDb | null = null

/** 惰性构造：模块求值期不做调用，否则打包器整块裁不掉本模块 */
export function getChatDexie(): ChatDb {
  return (handle ??= new ChatDb())
}
