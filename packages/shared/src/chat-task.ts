import type { PageContextInfo } from './chat-ipc'

export type ChatTaskStatus = 'running'

export interface ChatTaskRecord {
  taskId: string
  conversationId: string
  status: ChatTaskStatus
  step: number
  applyFailures: number
  code: string | null
  prompt: string
  pageContext?: PageContextInfo
  createdAt: number
  updatedAt: number
  heartbeat: number
}
