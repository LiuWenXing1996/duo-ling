// AI SDK 流式通道（方案 B 阶段 A）的渲染层 transport。
//
// 主进程 streamText + toUIMessageStream 产出的原生 ReadableStream 无法过 contextBridge
// （结构化克隆不支持原生流），因此主进程把它逐 chunk 经 EVENT_CH.agentStream 推送、
// 结束再推 EVENT_CH.agentStreamEnd。本 transport 把「事件推流」重新封装成 useChat 期望的
// ReadableStream<UIMessageChunk>，从而让渲染层 @ai-sdk/vue useChat({ transport }) 直接驱动整条链路。
//
// 阶段 A 只关注正文 + reasoning 透传，不接工具；reconnectToStream 暂不支持（返回 null）。

import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'

type StreamItem = { chunk?: UIMessageChunk; done: boolean }

/**
 * 主进程逐 chunk 事件 → 消费端的异步队列。
 * - 事件先到则入队；pull 先到则挂起等到下一个 chunk。
 * - close(error) 幂等：先补一个 error chunk（若失败），再宣告流结束。
 */
class AgentStreamQueue {
  private items: UIMessageChunk[] = []
  private waiters: Array<(item: StreamItem) => void> = []
  private done = false

  /** 入队一个 chunk；流已结束则丢弃（主进程在结束后不应再推 chunk）。 */
  enqueue(chunk: UIMessageChunk): void {
    if (this.done) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ chunk, done: false })
    else this.items.push(chunk)
  }

  /** 结束流：先补一个 error chunk（若失败），再唤醒所有等待者返回 done。幂等。 */
  close(error?: string): void {
    if (this.done) return
    if (error) {
      this.enqueue({ type: 'error', errorText: error })
    }
    this.done = true
    while (this.waiters.length) this.waiters.shift()!({ done: true })
  }

  /** 取下一个 item；有缓冲返回缓冲，已结束返回 done，否则挂起等待。 */
  read(): Promise<StreamItem> {
    if (this.items.length) return Promise.resolve({ chunk: this.items.shift()!, done: false })
    if (this.done) return Promise.resolve({ done: true })
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}

/**
 * 通过 window.api.agent 流式通道发起一次生成，并把逐 chunk 事件拼成 ReadableStream 返回。
 * useChat 消费该流（内部 readUIMessageStream 累积为 UIMessage.parts）。
 */
async function startAgentStream(
  messages: UIMessage[],
  abortSignal: AbortSignal | undefined
): Promise<ReadableStream<UIMessageChunk>> {
  const queue = new AgentStreamQueue()

  // 主进程逐 chunk 推送 → 入队供消费端拉取
  const offChunk = window.api.agent.onStreamChunk((chunk) => queue.enqueue(chunk))
  // 主进程流结束 → 补 error chunk（失败时）并关闭流
  const offEnd = window.api.agent.onStreamEnd((result) => queue.close(result.error))

  // 用户主动停止 / useChat 取消：通知主进程 abort，并把流收尾为「已停止」
  const onAbort = () => {
    void window.api.agent.abort()
    queue.close('生成已停止')
  }
  abortSignal?.addEventListener('abort', onAbort, { once: true })

  const cleanup = () => {
    offChunk()
    offEnd()
    abortSignal?.removeEventListener('abort', onAbort)
  }

  // 立即发起生成（不阻塞流返回）：主进程逐 chunk 经事件实时入队，消费端 pull 即拉即走，
  // useChat 才能逐 chunk 更新消息实现流式渲染。若这里 await streamSend，则主进程要等推完
  // 整条流才 resolve，所有 chunk 一次性缓冲、消费端合并渲染（表现为「文字一起跳出来」）。
  void window.api.agent
    .streamSend(messages)
    .then(
      (result) => queue.close(result.error),
      (error) => queue.close(error instanceof Error ? error.message : String(error))
    )
    .finally(cleanup)

  return new ReadableStream<UIMessageChunk>({
    pull(controller) {
      return queue.read().then(({ chunk, done }) => {
        if (done) controller.close()
        else controller.enqueue(chunk)
      })
    },
    cancel() {
      void window.api.agent.abort()
      queue.close()
    }
  })
}

/**
 * 桥接 @ai-sdk/vue useChat 到 Electron 主进程的 AI SDK 流式通道。
 * 用法：useChat({ id, transport: new ElectronChatTransport() })
 */
export class ElectronChatTransport implements ChatTransport<UIMessage> {
  async sendMessages(options: {
    trigger: 'submit-message' | 'regenerate-message'
    chatId: string
    messageId: string | undefined
    messages: UIMessage[]
    abortSignal: AbortSignal | undefined
  }): Promise<ReadableStream<UIMessageChunk>> {
    return startAgentStream(options.messages, options.abortSignal)
  }

  // 阶段 A 不做流重连；返回 null 表示无可用重连流
  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null
  }
}
