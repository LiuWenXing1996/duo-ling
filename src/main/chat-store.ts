import Store, { type Schema } from 'electron-store'

export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  id: number
  role: ChatRole
  content: string
  createdAt: string
}

interface ChatState {
  sessions: Record<string, ChatMessage[]>
}

// JSON Schema 校验：拒绝畸形数据
const schema: Schema<ChatState> = {
  sessions: {
    type: 'object',
    additionalProperties: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'role', 'content', 'createdAt'],
        properties: {
          id: { type: 'number' },
          role: { type: 'string', enum: ['user', 'assistant'] },
          content: { type: 'string' },
          createdAt: { type: 'string' }
        },
        additionalProperties: false
      }
    }
  }
}

let store: Store<ChatState> | undefined

// 惰性创建：首次调用发生在 IPC 处理时（userData 覆盖已生效）
function getStore(): Store<ChatState> {
  store ??= new Store<ChatState>({
    name: 'chat',
    defaults: { sessions: {} },
    schema
  })
  return store
}

export function listChatMessages(taskId: number): ChatMessage[] {
  return getStore().get('sessions')[String(taskId)] ?? []
}

export function appendChatMessage(taskId: number, message: ChatMessage): void {
  const key = String(taskId)
  const sessions = getStore().get('sessions')
  const current = sessions[key] ?? []
  getStore().set('sessions', { ...sessions, [key]: [...current, message] })
}
