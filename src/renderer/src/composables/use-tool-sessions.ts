import { computed, ref } from 'vue'
import type { GeneratedChangeList } from '@/lib/tool-generator'
import { formatDate } from '@/lib/format'

// 一个工具会话（多会话：切换回显 + 本地持久化）
export interface ToolSession {
  id: string
  status: 'doing' | 'done' | 'rollback'
  title: string
  meta: string
}

export interface ToolChatMessage {
  id: string
  role: 'ai' | 'user'
  content: string
}

// 自动落盘留痕：AI 产出变更清单后直接应用，卡片仅作留痕展示（无手动应用/放弃）
export interface PendingChange {
  messageId: string
  changes: GeneratedChangeList
  error?: string
}

interface SessionStore {
  sessions: ToolSession[]
  messagesBySession: Record<string, ToolChatMessage[]>
  pendingBySession: Record<string, Record<string, PendingChange>>
  activeSessionId: string
}

// 兼容旧版本单例存储（Record<sessionId, PendingChange | null>）迁移为按消息分桶
function normalizePendingStore(
  store: unknown
): Record<string, Record<string, PendingChange>> {
  const out: Record<string, Record<string, PendingChange>> = {}
  if (!store || typeof store !== 'object') return out
  for (const [sid, val] of Object.entries(store as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') {
      out[sid] = {}
      continue
    }
    const v = val as Record<string, unknown>
    // 旧结构：单个卡片（含 messageId）或 null；新结构：messageId -> 卡片的哈希
    if (typeof v.messageId === 'string') {
      const pc = val as unknown as PendingChange
      out[sid] = typeof pc.messageId === 'string' ? { [pc.messageId]: pc } : {}
    } else {
      const map: Record<string, PendingChange> = {}
      for (const [mid, card] of Object.entries(v)) {
        if (card && typeof card === 'object' && (card as PendingChange).messageId) {
          map[mid] = card as PendingChange
        }
      }
      out[sid] = map
    }
  }
  return out
}

/** 工具会话状态：按工具 id 分桶持久化到 localStorage，切换/重启后不丢。 */
export function useToolSessions(
  getToolId: () => string,
  options: { clearDraft?: () => void } = {}
) {
  // 「当前会话」按工具内会话隔离：每个 session 有独立消息列表，切换会话时回显。
  const sessions = ref<ToolSession[]>([])
  const activeSessionId = ref('')
  const messagesBySession = ref<Record<string, ToolChatMessage[]>>({})
  // 变更留痕卡片按「会话 + 消息」记录：同一会话内每条 AI 变更消息都保留独立卡片，
  // 成功/失败状态随卡片持久化，切换会话时回显原状态。
  const pendingBySession = ref<Record<string, Record<string, PendingChange>>>({})

  // messages 是「当前激活会话」消息的视图：读跟随 activeSessionId，写回对应桶
  const messages = computed<ToolChatMessage[]>({
    get: () => messagesBySession.value[activeSessionId.value] ?? [],
    set: (v) => {
      messagesBySession.value[activeSessionId.value] = v
    }
  })
  // 当前激活会话的卡片映射（messageId -> PendingChange），切换会话时随 activeSessionId 回显
  const pendingMap = computed<Record<string, PendingChange>>(
    () => pendingBySession.value[activeSessionId.value] ?? {}
  )

  // —— 会话持久化：按工具 id 分桶存 localStorage ——
  function storageKey(): string {
    return `duo-ling:tool:sessions:${getToolId()}`
  }

  function loadSessions(): SessionStore | null {
    try {
      const raw = localStorage.getItem(storageKey())
      return raw ? (JSON.parse(raw) as SessionStore) : null
    } catch {
      return null
    }
  }

  function saveSessions(): void {
    try {
      localStorage.setItem(
        storageKey(),
        JSON.stringify({
          sessions: sessions.value,
          messagesBySession: messagesBySession.value,
          pendingBySession: pendingBySession.value,
          activeSessionId: activeSessionId.value
        } satisfies SessionStore)
      )
    } catch (error) {
      console.error('保存会话失败：', error)
    }
  }

  function newSession(): void {
    const id = `s-${Date.now()}`
    const session: ToolSession = {
      id,
      status: 'doing',
      title: '新会话',
      meta: formatDate(new Date())
    }
    sessions.value.push(session)
    messagesBySession.value[id] = []
    activeSessionId.value = id
    pendingBySession.value[id] = {}
    saveSessions()
  }

  // 切换到某会话：更新活动 id 即回显对应消息与待审批卡片；仅清掉流式草稿（草稿为临时态）
  function activateSession(id: string): void {
    if (id === activeSessionId.value) return
    activeSessionId.value = id
    options.clearDraft?.()
    saveSessions()
  }

  function deleteSession(id: string): void {
    sessions.value = sessions.value.filter((s) => s.id !== id)
    delete messagesBySession.value[id]
    delete pendingBySession.value[id]
    if (activeSessionId.value === id) {
      activeSessionId.value = ''
      // 仍有余下会话则激活第一个；否则新建空会话保证当前会话始终存在
      if (sessions.value.length) {
        activeSessionId.value = sessions.value[0].id
      } else {
        newSession()
        return
      }
    }
    saveSessions()
  }

  function deleteAllSessions(): void {
    sessions.value = []
    messagesBySession.value = {}
    pendingBySession.value = {}
    activeSessionId.value = ''
    options.clearDraft?.()
    newSession()
  }

  /** 恢复本工具的会话历史（多会话：切换回显 + 本地持久化）；无可用会话时自动新建。 */
  function restore(): void {
    const saved = loadSessions()
    if (saved) {
      sessions.value = saved.sessions ?? []
      messagesBySession.value = saved.messagesBySession ?? {}
      pendingBySession.value = normalizePendingStore(saved.pendingBySession)
      activeSessionId.value = saved.activeSessionId ?? ''
    }
    if (!activeSessionId.value || !sessions.value.some((s) => s.id === activeSessionId.value)) {
      newSession()
    }
  }

  /** 取某条 AI 消息挂载的变更卡片（可能不存在，如自动模式或无变更） */
  function pendingOf(messageId: string): PendingChange | undefined {
    return pendingMap.value[messageId]
  }

  return {
    sessions,
    activeSessionId,
    messages,
    pendingMap,
    restore,
    newSession,
    activateSession,
    deleteSession,
    deleteAllSessions,
    saveSessions,
    pendingOf
  }
}
