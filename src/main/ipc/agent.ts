// AI 对话 IPC：唯一对话链路入口（含 Agent Loop 多轮工具调用）。
// 渲染层聊天/工具意图统一走此通道：主进程编排多轮、执行 Agent 工具、流式回推事件。
import { ipcMain } from 'electron'
import { CH, EVENT_CH } from '../../shared/ipc'
import type { AgentStreamSendResult, AgentToolContext } from '../../shared/types'
import type { UIMessage } from 'ai'
import { streamAisdkReply } from '../agent-orchestrator'
import { isConfigured } from '../model-store'
import { getAgentAbortController, setAgentAbortController } from './state'

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
}
