// AI 对话 IPC：唯一对话链路入口（含 Agent Loop 多轮工具调用）。
// 渲染层聊天/工具意图统一走此通道：主进程编排多轮、执行 Agent 工具、流式回推事件。
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { CH, EVENT_CH } from '../../shared/ipc'
import type {
  ChatMessage,
  AgentEventData,
  AgentMessage,
  AgentStreamSendResult,
  AgentToolContext
} from '../../shared/types'
import type { UIMessage } from 'ai'
import { generateChat, isConfigured, streamAisdkReply } from '../online-llm'
import { buildAgentTools, executeAgentTool } from '../agent-tools'
import { getAgentAbortController, setAgentAbortController } from './state'

function sendAgentEvent(event: IpcMainInvokeEvent, payload: AgentEventData): void {
  event.sender.send(EVENT_CH.agent, payload)
}

export function registerAgentIpc(): void {
  ipcMain.handle(CH.agentAbort, () => {
    getAgentAbortController()?.abort()
  })

  ipcMain.handle(
    CH.agentStreamSend,
    async (
      event,
      messages: UIMessage[],
      _context?: AgentToolContext
    ): Promise<AgentStreamSendResult> => {
      if (!Array.isArray(messages) || messages.length === 0) {
        return { ok: false, error: '对话消息不能为空' }
      }
      if (!isConfigured()) {
        return { ok: false, error: '尚未配置可用的在线模型，请先在「设置」中添加' }
      }
      if (getAgentAbortController()) {
        return { ok: false, error: '当前有正在生成的回复，请先停止' }
      }
      const last = messages[messages.length - 1]
      if (last.role !== 'user') {
        return { ok: false, error: '最后一条消息应为用户输入' }
      }

      const abort = new AbortController()
      setAgentAbortController(abort)
      const systemPrompt = '你是 Duo Ling 的 AI 助手，请用中文回答。'

      try {
        // streamAisdkReply 逐 chunk 回调；这里把它经 webContents.send 推给渲染层，渲染层 transport 收集为流
        const result = await streamAisdkReply(messages, systemPrompt, {
          signal: abort.signal,
          onChunk: (chunk) => event.sender.send(EVENT_CH.agentStream, chunk),
          // 工具执行的副作用：AI 决定「打开/新建工具」时广播命令，渲染层据此切换工具标签页
          hooks: {
            onOpenTool: (cmd) => event.sender.send(EVENT_CH.toolOpenCommand, cmd)
          }
        })
        event.sender.send(EVENT_CH.agentStreamEnd, result)
        return result
      } catch (error) {
        // streamAisdkReply 内部已吞掉流错误并返回 { ok:false }；此处仅兜底真正抛出的异常（如 isConfigured 抛错）
        const message = error instanceof Error ? error.message : String(error)
        const result: AgentStreamSendResult = { ok: false, error: message }
        event.sender.send(EVENT_CH.agentStreamEnd, result)
        return result
      } finally {
        if (getAgentAbortController() === abort) setAgentAbortController(undefined)
      }
    }
  )

  ipcMain.handle(
    CH.agentSend,
    async (
      event,
      history: AgentMessage[],
      _context?: AgentToolContext
    ): Promise<{ ok: boolean; content?: string; reasoning?: string; error?: string }> => {
      if (!Array.isArray(history) || history.length === 0) {
        return { ok: false, error: '对话历史不能为空' }
      }
      if (!isConfigured()) {
        return { ok: false, error: '尚未配置可用的在线模型，请先在「设置」中添加' }
      }
      if (getAgentAbortController()) {
        return { ok: false, error: '当前有正在生成的回复，请先停止' }
      }

      // 最后一条为用户消息，其余作为历史
      const last = history[history.length - 1]
      if (last.role !== 'user') {
        return { ok: false, error: '最后一条消息应为用户输入' }
      }
      const historyMsgs: ChatMessage[] = history
        .slice(0, -1)
        .map((m, i) => ({
          id: Date.now() + i,
          role: m.role,
          content: m.content,
          createdAt: new Date().toISOString()
        }))

      const abort = new AbortController()
      setAgentAbortController(abort)
      const systemPrompt = '你是 Duo Ling 的 AI 助手，请用中文回答。'
      let content = ''
      let reasoning = ''

      try {
        const reply = await generateChat(
          systemPrompt,
          historyMsgs,
          last.content,
          (token) => {
            content += token
            sendAgentEvent(event, { type: 'token', token })
          },
          abort.signal,
          {
            // Agent Loop：给 LLM 声明可调用工具（本期：查工具 / 打开工具）
            tools: buildAgentTools(),
            // 推理模型思考过程：与正文分离，单独推给渲染层（对应业界标准 reasoning 字段）
            onReasoning: (text) => {
              reasoning += text
              sendAgentEvent(event, { type: 'reasoning', text })
            },
            // 逐步把工具调用事件推给渲染层作步骤展示（对应 DeepSeek「搜索/引用」样式）
            onToolStart: (call) => {
              sendAgentEvent(event, {
                type: 'tool_start',
                name: call.name,
                arguments: call.arguments
              })
            },
            onToolResult: (name, result) => {
              sendAgentEvent(event, {
                type: 'tool_result',
                name,
                ok: result.ok,
                result: result.result,
                error: result.error
              })
            },
            // 执行工具；「打开工具」的副作用经 event.sender 广播命令，让渲染层切换工具标签页
            executeTool: (name, argsJson) =>
              executeAgentTool(name, argsJson, {
                onOpenTool: (cmd) => event.sender.send(EVENT_CH.toolOpenCommand, cmd)
              })
          }
        )
        sendAgentEvent(event, { type: 'done', content: reply.content, reasoning: reply.reasoning })
        return { ok: true, content: reply.content, reasoning: reply.reasoning }
      } catch (error) {
        if (abort.signal.aborted) {
          sendAgentEvent(event, { type: 'aborted', content, reasoning })
          return { ok: false, content, reasoning }
        }
        const message = error instanceof Error ? error.message : String(error)
        sendAgentEvent(event, { type: 'error', error: message })
        return { ok: false, error: message }
      } finally {
        if (getAgentAbortController() === abort) setAgentAbortController(undefined)
      }
    }
  )
}
