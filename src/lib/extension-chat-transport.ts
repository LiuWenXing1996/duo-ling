// AI SDK 流式通道的扩展版 transport。
//
// 与桌面版的差异（桌面版见 legacy/src/renderer/src/lib/custom-chat-transport.ts）：
//   桌面版：主进程跑 streamText，逐 chunk 经 IPC 事件推给渲染层，渲染层再把「事件推流」
//           重新封装成 ReadableStream<UIMessageChunk>（因为原生流无法过 contextBridge）。
//   扩展版：没有 preload 这层限制。扩展页在 manifest 声明 host_permissions 后可直接跨域 fetch，
//           于是在渲染层直接跑 streamText，把它的 fullStream 转成 UI message stream 返回。
//           少一次中转，也摆脱了 service worker 生命周期对长连接的干扰。
//
// 注意：本次仅接「纯对话」链路（无 Agent 工具）。桌面版 streamText 里的 tools / stopWhen
// 多步循环属于 agent 编排，待 capability runtime 在扩展侧打通后再补。

import { convertToModelMessages, streamText, toUIMessageStream } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import type { TokenUsage } from '@/shared/types'
import { getActiveProfileState } from './model-store'

export class ExtensionChatTransport implements ChatTransport<UIMessage> {
  // 最近一次已结束流的 token 用量；由使用方在 onFinish 读取并清空
  private lastUsage: TokenUsage | undefined = undefined

  /** 读取最近一次生成消耗的 token（配合 onFinish/持久化使用） */
  getLastUsage(): TokenUsage | undefined {
    return this.lastUsage
  }

  /** 清空已读取的用量，避免下一条消息串到旧值 */
  clearUsage(): void {
    this.lastUsage = undefined
  }

  async sendMessages(options: {
    trigger: 'submit-message' | 'regenerate-message'
    chatId: string
    messageId: string | undefined
    messages: UIMessage[]
    abortSignal: AbortSignal | undefined
  }): Promise<ReadableStream<UIMessageChunk>> {
    // 每次发起生成前清空上次用量，确保 onFinish 读到的属于本次流
    this.lastUsage = undefined

    const profile = await getActiveProfileState()
    if (!profile) {
      throw new Error('尚未配置可用的在线模型，请先在「设置」中添加')
    }

    // @ai-sdk/openai-compatible 固定会在 baseURL 后追加 /chat/completions；
    // useFullUrl 时 baseUrl 已是完整接口地址（含 /chat/completions），先剥离避免重复拼接。
    const baseURL = profile.useFullUrl
      ? profile.baseUrl.replace(/\/chat\/completions\/?$/i, '')
      : profile.baseUrl

    const provider = createOpenAICompatible({
      name: 'openaiCompatible',
      baseURL,
      apiKey: profile.apiKey || 'not-needed'
    })

    // 渲染层 useChat 产出的 UIMessage[] 转成模型消息（reasoning part 默认不回传模型，避免污染历史）
    const modelMessages = await convertToModelMessages(options.messages)

    const result = streamText({
      model: provider.chatModel(profile.model),
      messages: modelMessages,
      abortSignal: options.abortSignal,
      ...(profile.temperature != null ? { temperature: profile.temperature } : {}),
      ...(profile.topP != null ? { topP: profile.topP } : {}),
      ...(profile.contextOutputToken != null ? { maxOutputTokens: profile.contextOutputToken } : {}),
      // AI SDK 的 usage 只在 streamText.onFinish 可得（useChat.onFinish 无该字段）
      onFinish: ({ usage }) => {
        this.lastUsage = {
          inputTokens: usage?.inputTokens ?? undefined,
          outputTokens: usage?.outputTokens ?? undefined,
          totalTokens: usage?.totalTokens ?? undefined
        }
      }
    })

    // 直接返回 UI message stream 供 useChat 消费（内部 readUIMessageStream 累积为 UIMessage.parts）
    return toUIMessageStream({
      stream: result.fullStream,
      sendReasoning: true,
      sendStart: true,
      sendFinish: true
    })
  }

  // 暂不支持流重连；返回 null 表示无可用重连流
  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null
  }
}
