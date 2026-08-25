// 对话 IPC：按任务（会话）读写历史，流式生成回复。
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { CH, EVENT_CH } from '../../shared/ipc'
import type { ChatEventData, ChatMessage } from '../../shared/types'
import { generateReply, isConfigured } from '../online-llm'
import { listChatMessages, appendChatMessage } from '../chat-store'
import { listTasks, renameTask } from '../store'
import { getChatAbortController, setChatAbortController } from './state'

function sendChatEvent(event: IpcMainInvokeEvent, payload: ChatEventData): void {
  event.sender.send(EVENT_CH.chat, payload)
}

export function registerChatIpc(): void {
  ipcMain.handle(CH.chatHistory, (_event, taskId: number) => listChatMessages(taskId))

  ipcMain.handle(CH.chatSend, async (event, taskId: number, text: string) => {
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('消息不能为空')
    }
    if (!isConfigured()) {
      throw new Error('尚未配置可用的在线模型，请先在「设置」中添加')
    }
    if (getChatAbortController()) {
      throw new Error('当前有正在生成的回复，请先停止')
    }

    const userMessage: ChatMessage = {
      id: Date.now(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString()
    }
    appendChatMessage(taskId, userMessage)

    // 历史为当前用户消息之前的部分
    const history = listChatMessages(taskId).slice(0, -1)

    // 首条消息自动命名：标题仍是自动生成的「新会话*」时，用首条消息前缀替换
    if (history.length === 0) {
      const current = listTasks().find((task) => task.id === taskId)
      if (current && current.title.startsWith('新会话')) {
        renameTask(taskId, text.trim().slice(0, 15))
      }
    }

    const abort = new AbortController()
    setChatAbortController(abort)
    let full = ''

    try {
      const reply = await generateReply(history, text, (token) => {
        full += token
        sendChatEvent(event, { type: 'token', taskId, token })
      }, abort.signal)
      const assistantMessage: ChatMessage = {
        id: Date.now(),
        role: 'assistant',
        content: reply,
        createdAt: new Date().toISOString()
      }
      appendChatMessage(taskId, assistantMessage)
      sendChatEvent(event, { type: 'done', taskId, message: assistantMessage })
      return assistantMessage
    } catch (error) {
      if (abort.signal.aborted) {
        // 中止时保留已生成的部分回复
        const content = full.trim()
        const message = content
          ? ({
              id: Date.now(),
              role: 'assistant',
              content,
              createdAt: new Date().toISOString()
            } satisfies ChatMessage)
          : null
        if (message) appendChatMessage(taskId, message)
        sendChatEvent(event, { type: 'aborted', taskId, message })
        return message
      }
      const message = error instanceof Error ? error.message : String(error)
      sendChatEvent(event, { type: 'error', taskId, error: message })
      throw error
    } finally {
      if (getChatAbortController() === abort) setChatAbortController(undefined)
    }
  })

  ipcMain.handle(CH.chatAbort, () => {
    getChatAbortController()?.abort()
  })
}
