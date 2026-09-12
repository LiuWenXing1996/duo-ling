// 会话 IPC：把「会话」从工具会话（localStorage 分桶）提升为主进程一等公民的落地层（Phase 1·解耦）。
//
// 通道：
//   conversation:list              —— 会话列表（按最后消息时间倒序）
//   conversation:create            —— 新建会话（标题「新会话 N」）
//   conversation:rename            —— 重命名会话
//   conversation:messages          —— 某会话的消息列表
//   conversation:appendMessage     —— 追加一条消息并刷新会话 lastMessageAt
//   conversation:applyIntents      —— 对某条 AI 消息批量应用「多工具编辑意图」并逐工具落盘
//
// applyIntents 是多工具契约的执行端：它把渲染层解析出的 intents[]（{toolId,summary,actions}）
// 逐条登记为 EditIntent（留痕），再复用 tool-page.applyToolChanges + tool-git.commitToolChanges
// 逐工具落盘并提交，最后把每个工具的结果（成功/失败、最新标题）回传给渲染层。
import { ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import type {
  ApplyIntentsInput,
  ApplyIntentsResult,
  ApplyIntentEntryResult,
  Message,
  MessageRole
} from '../../shared/types'
import {
  addIntent,
  appendMessage,
  createConversation,
  deleteAllConversations,
  deleteConversation,
  listConversationIntents,
  listConversations,
  listMessages,
  renameConversation,
  searchConversations,
  setIntentStatus
} from '../conversation-store'
import { applyToolChanges } from '../tool-page'
import { commitToolChanges } from '../tool-git'

/** 对一条 AI 消息声明的一批工具意图逐工具应用并落盘，返回每工具结果。 */
async function applyIntents(input: ApplyIntentsInput): Promise<ApplyIntentsResult> {
  if (!input || typeof input !== 'object' || typeof input.messageId !== 'string') {
    return { ok: false, results: [], error: '入参不合法' }
  }
  if (!Array.isArray(input.intents) || input.intents.length === 0) {
    return { ok: false, results: [], error: '没有可应用的意图' }
  }
  const results: ApplyIntentEntryResult[] = []
  for (const intent of input.intents) {
    // 先登记一个「待应用」的编辑意图作为留痕（失败会转 failed 并记录 error）
    const record = addIntent(input.messageId, intent.toolId, intent.summary, intent.actions)
    if (!intent.toolId || typeof intent.toolId !== 'string') {
      setIntentStatus(record.id, 'failed', '缺少工具 id')
      results.push({ toolId: "", ok: false, error: '缺少工具 id' })
      continue
    }
    try {
      const applied = applyToolChanges(intent.toolId, {
        summary: intent.summary,
        actions: intent.actions
      })
      if (applied.ok) {
        // 落盘成功 → 提交一次（一次意图 = 一个 commit，message 用 summary）
        await commitToolChanges(intent.toolId, intent.summary)
        setIntentStatus(record.id, 'applied')
        results.push({ toolId: intent.toolId, ok: true, title: applied.title })
      } else {
        setIntentStatus(record.id, 'failed', applied.error)
        results.push({ toolId: intent.toolId, ok: false, error: applied.error })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setIntentStatus(record.id, 'failed', message)
      results.push({ toolId: intent.toolId, ok: false, error: message })
    }
  }

  const allOk = results.every((r) => r.ok)
  return allOk
    ? { ok: true, results }
    : { ok: false, results, error: '部分工具应用失败' }
}

export function registerConversationIpc(): void {
  ipcMain.handle(CH.conversationList, () => listConversations())
  ipcMain.handle(CH.conversationSearch, (_event, query: string) => searchConversations(query))
  ipcMain.handle(CH.conversationCreate, () => createConversation())
  ipcMain.handle(CH.conversationRename, (_event, id: string, title: string) =>
    renameConversation(id, title)
  )
  ipcMain.handle(CH.conversationMessages, (_event, conversationId: string): Message[] =>
    listMessages(conversationId)
  )
  ipcMain.handle(
    CH.conversationAppendMessage,
    (
      _event,
      conversationId: string,
      role: MessageRole,
      content: string,
      reasoning?: string,
      parts?: Message['parts'],
      usage?: Message['usage']
    ): Message | null => appendMessage(conversationId, role, content, reasoning, parts, usage)
  )
  ipcMain.handle(CH.conversationApplyIntents, (_event, input: ApplyIntentsInput) =>
    applyIntents(input)
  )
  ipcMain.handle(CH.conversationIntents, (_event, conversationId: string) =>
    listConversationIntents(conversationId)
  )
  ipcMain.handle(CH.conversationDelete, (_event, id: string) => deleteConversation(id))
  ipcMain.handle(CH.conversationDeleteAll, () => deleteAllConversations())
}
