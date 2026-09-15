// AI SDK 流式通道的扩展版 transport（2026-09-15 起宿主收敛 offscreen，定位 B）。
//
// 演进史（读代码前先看，避免按旧注释理解）：
//   v1  渲染层直跑 streamText —— 少一次中转，但侧边栏一关流当场断。
//   v2  整条对话链路搬进 offscreen（docs/userscript-ai-generation.md §4.8 定位 B）：
//       本文件退回纯「观察者」角色——sendMessages 只是把指令 + 消息交给 offscreen
//       （chat:start），随后把 offscreen 推回的事件（chat:chunk）收集成 ReadableStream
//       喂给 useChat；reconnectToStream 第一次有了真实语义：重连时从头全量回放
//       offscreen 侧的 per-task 事件缓冲，实现「关面板任务照跑、重开面板接上」。
//
// 会话 id 的约定：useChat 实例是单例、内部 chatId 每次挂载随机生成，与本扩展的
// conversationId 对不上。本 transport 自持 currentConversationId（由
// use-global-conversation 在激活会话时设置），chat:* 命令一律以它为准。

import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import type {
  ChatResumeResult,
  OffscreenPush,
  RuntimeRequest,
  RuntimeResponse,
} from '@/shared/extension-ipc'

/** 向 offscreen 发一次请求（共享总线，SW 对 chat: 前缀静默让路），统一解包信封 */
function send<T>(request: RuntimeRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response: RuntimeResponse<T> | undefined) => {
      const lastError = chrome.runtime.lastError
      if (lastError) {
        reject(new Error(lastError.message))
        return
      }
      if (!response) {
        reject(new Error('offscreen 无响应'))
        return
      }
      if (!response.ok) {
        reject(new Error(response.error))
        return
      }
      resolve(response.data as T)
    })
  })
}

/**
 * 失败先唤起容器再重试（与 ui-client.sendAi 同构）：offscreen 被回收 / 扩展重载时，
 * chat:* 无人应答报「port closed」类错误——ensure（SW 侧轮询 ai:ping 到可应答）后重试一次。
 */
async function sendChat<T>(request: RuntimeRequest): Promise<T> {
  try {
    return await send<T>(request)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/port closed|Receiving end does not exist|无响应/.test(msg)) throw e
    await send({ kind: 'offscreen:ensure' }).catch(() => {})
    return await send<T>(request)
  }
}

// —— 事件消费登记表（模块级：offscreen 的推送与 transport 实例解耦） ——

interface StreamConsumer {
  controller: ReadableStreamDefaultController<UIMessageChunk>
}

const consumers = new Map<string, StreamConsumer>()
/** 各会话已消费到的最大 seq（防回放与实时推送短暂重叠时重复入流；
 * 新任务开始 / 重连回放前清零——offscreen 的 seq 每轮任务重计，且观察方
 * 本地视图可能刚从历史重建） */
const lastSeq = new Map<string, number>()

function isTerminalChunk(chunk: UIMessageChunk): boolean {
  return chunk.type === 'finish' || chunk.type === 'abort'
}

/** 消费一条推送；返回是否为终止事件（调用方据此关流） */
function consumeChunk(conversationId: string, seq: number, chunk: UIMessageChunk): boolean {
  const consumer = consumers.get(conversationId)
  if (!consumer) return false
  const seen = lastSeq.get(conversationId) ?? 0
  if (seq <= seen) return false // 去重：重连 replay 与实时推送可能短暂重叠
  lastSeq.set(conversationId, seq)
  consumer.controller.enqueue(chunk)
  return isTerminalChunk(chunk)
}

function closeConsumer(conversationId: string): void {
  const consumer = consumers.get(conversationId)
  if (!consumer) return
  consumers.delete(conversationId)
  try {
    consumer.controller.close()
  } catch {
    // useChat 停止时会 cancel 流，controller 可能已关
  }
}

// 模块级订阅：只注册一次。offscreen → 侧边栏的事件推送都从这里进流。
let pushListenerInstalled = false
function installPushListener(): void {
  if (pushListenerInstalled) return
  pushListenerInstalled = true
  chrome.runtime.onMessage.addListener((raw) => {
    const push = raw as OffscreenPush | undefined
    if (push?.kind !== 'chat:chunk') return
    if (consumeChunk(push.conversationId, push.seq, push.chunk)) {
      closeConsumer(push.conversationId)
    }
  })
}

/** 档 0 页面上下文（方案 §4.2）：侧边栏是扩展页，可直接读当前标签 URL / 标题
 *  （host_permissions <all_urls> 已覆盖，无需 tabs 权限）；offscreen 没有 chrome.tabs */
async function collectPageContext(): Promise<{ url?: string; title?: string } | undefined> {
  try {
    if (!chrome.tabs?.query) return undefined
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.url) return undefined
    return { url: tab.url, ...(tab.title ? { title: tab.title } : {}) }
  } catch {
    return undefined
  }
}

export class ExtensionChatTransport implements ChatTransport<UIMessage> {
  /** 当前会话 id（由 use-global-conversation 在激活会话时设置；chat:* 命令以它为准） */
  currentConversationId = ''

  setConversationId(id: string): void {
    this.currentConversationId = id
  }

  async sendMessages(options: {
    trigger: 'submit-message' | 'regenerate-message'
    chatId: string
    messageId: string | undefined
    messages: UIMessage[]
    abortSignal: AbortSignal | undefined
  }): Promise<ReadableStream<UIMessageChunk>> {
    installPushListener()
    const conversationId = this.currentConversationId || options.chatId

    const stream = new ReadableStream<UIMessageChunk>({
      start: async (controller) => {
        // 先登记消费者再发指令：offscreen 的首条推送可能早于 chat:start 的应答返回。
        // 去重基线一并清掉：offscreen 的 seq 每轮任务从 1 重计，留着上一轮的基线
        // 会把新一轮的开头（start / reasoning-start 等配对块）当重播丢掉。
        lastSeq.delete(conversationId)
        consumers.set(conversationId, { controller })
        try {
          const pageContext = await collectPageContext()
          await sendChat({
            kind: 'chat:start',
            conversationId,
            messages: JSON.parse(JSON.stringify(options.messages)) as UIMessage[],
            trigger: options.trigger,
            ...(pageContext ? { pageContext } : {}),
          })
        } catch (e) {
          consumers.delete(conversationId)
          // start 块先行：useChat 在未 start 时收到 error 块可能整体丢弃（不报错、状态卡 streaming）
          controller.enqueue({ type: 'start', messageId: options.messageId })
          controller.enqueue({
            type: 'error',
            errorText: e instanceof Error ? e.message : String(e),
          })
          controller.enqueue({ type: 'abort' })
          controller.close()
        }
      },
      cancel: () => {
        // useChat 停止 / 切换会话时本地断流。注意：这里**不**发 chat:abort——
        // 「切换会话」不该杀掉 offscreen 里照跑的任务；用户显式点停止由
        // stopGeneration 经 abortCurrent() 通知（见 use-global-conversation）。
        consumers.delete(conversationId)
      },
    })
    return stream
  }

  /** 用户显式停止（停止按钮）：通知 offscreen 终止任务。切换会话不调用此方法 */
  abortCurrent(): void {
    const conversationId = this.currentConversationId
    if (!conversationId) return
    void sendChat({ kind: 'chat:abort', conversationId }).catch(() => {})
  }

  /**
   * 重连（面板重开 / 切回会话后由 useChat 的 resumeStream 触发）：
   * offscreen 返回该会话进行中任务的**完整**事件缓冲（从头回放，见 chat-host.resumeChat），
   * 随后实时推送继续进同一流。无进行中任务返回 null（useChat 的既定语义），UI 以会话历史为准。
   */
  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    installPushListener()
    const conversationId = this.currentConversationId
    if (!conversationId) return null

    let res: ChatResumeResult
    try {
      res = await sendChat<ChatResumeResult>({ kind: 'chat:resume', conversationId })
    } catch {
      return null // 容器不在 / 命令失败：按「无可重连」处理
    }
    if (res.status !== 'running' || !res.events.length) return null

    // 去重基线清零后由回放事件重建：本地视图刚从历史重建（不含半截 assistant 消息），
    // 旧的基线只会把回放开头的配对块（start / reasoning-start）当重播丢掉。
    // 回放完基线停在缓冲尾，与后续实时推送自然衔接。
    lastSeq.delete(conversationId)

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        consumers.set(conversationId, { controller })
        for (const event of res.events) {
          if (consumeChunk(conversationId, event.seq, event.chunk)) {
            closeConsumer(conversationId)
            return
          }
        }
      },
      cancel: () => {
        consumers.delete(conversationId)
      },
    })
  }
}
