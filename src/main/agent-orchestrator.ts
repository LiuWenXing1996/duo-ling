// Agent 编排器：AI SDK 流式回复（方案 B）。
// 用 streamText + toUIMessageStream 产出 UI message stream，渲染层经 @ai-sdk/vue useChat({ transport })
// 消费。接入 buildAgentTools 后开启多步 Agent Loop：模型可调用工具，execute 执行结果以 tool message
// 回传模型继续生成，直到 stopWhen 达到步数上限或模型给出最终正文。
// 返回的 content/reasoning 来自对 UI 流的一次消费，供调用方持久化。

import { convertToModelMessages, streamText, toUIMessageStream, isStepCount } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { UIMessage } from 'ai'
import { buildAgentTools, type AgentToolHooks } from './agent-tools'
import { getActiveConfig, isConfigured } from './model-store'
import type { AgentStreamChunk, AgentStreamSendResult } from '../shared/types'

export interface StreamAisdkReplyOptions {
  /** 每收到一个 UIMessageChunk 即回调（主进程据此 webContents.send 推给渲染层） */
  onChunk: (chunk: AgentStreamChunk) => void
  signal: AbortSignal
  /** 工具执行钩子（如「打开工具」的副作用），透传给 buildAgentTools */
  hooks?: AgentToolHooks
}

export async function streamAisdkReply(
  messages: UIMessage[],
  systemPrompt: string,
  opts: StreamAisdkReplyOptions
): Promise<AgentStreamSendResult> {
  if (!isConfigured()) {
    throw new Error('尚未配置可用的在线模型，请先在「设置」中添加')
  }
  const config = getActiveConfig()

  // @ai-sdk/openai-compatible 固定会在 baseURL 后追加 /chat/completions；
  // useFullUrl 时 baseUrl 已是完整接口地址（含 /chat/completions），先剥离避免重复拼接。
  const baseUrl = config.useFullUrl
    ? config.baseUrl.replace(/\/chat\/completions\/?$/i, '')
    : config.baseUrl

  const provider = createOpenAICompatible({
    name: 'openaiCompatible',
    baseURL: baseUrl,
    apiKey: config.apiKey || 'not-needed'
  })

  // 渲染层 useChat 产出的 UIMessage[] 转成模型消息（reasoning part 默认不回传模型，避免污染历史）
  const modelMessages = await convertToModelMessages(messages)

  const aisdkTools = buildAgentTools(opts.hooks)

  const result = streamText({
    model: provider.chatModel(config.model),
    messages: modelMessages,
    // 系统提示词走 instructions 选项：AI SDK v7 的 messages 数组不允许 system 角色。
    ...(systemPrompt ? { instructions: systemPrompt } : {}),
    abortSignal: opts.signal,
    // 接入 Agent 工具并开启多步循环（对应 legacy maxRounds 默认 8）：模型可调用工具、结果回传后继续生成
    tools: aisdkTools,
    stopWhen: isStepCount(8),
    ...(config.temperature != null ? { temperature: config.temperature } : {}),
    ...(config.topP != null ? { topP: config.topP } : {}),
    ...(config.contextOutputToken != null ? { maxOutputTokens: config.contextOutputToken } : {})
    // 注：topK 对应的 providerOptions 在 @ai-sdk/openai-compatible 的 schema 中不存在（仅 user/reasoningEffort/
    // textVerbosity/strictJsonSchema），阶段 C 再决定是否用自定义 body 透传，这里暂不映射。
  })

  const uiStream = toUIMessageStream({
    stream: result.fullStream,
    // 传入 tools 以便 tool-call part 正确映射为 tool UI chunks（打开/结果/状态）
    tools: aisdkTools,
    sendReasoning: true,
    sendStart: true,
    sendFinish: true
  })

  const reader = uiStream.getReader()
  let content = ''
  let reasoning = ''
  let error: string | undefined
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      opts.onChunk(value as AgentStreamChunk)
      if (value.type === 'text-delta') content += value.delta
      else if (value.type === 'reasoning-delta') reasoning += value.delta
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return error ? { ok: false, content, reasoning, error } : { ok: true, content, reasoning }
}
