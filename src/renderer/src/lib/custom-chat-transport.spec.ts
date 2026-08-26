import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readUIMessageStream, type UIMessageChunk } from 'ai'
import { ElectronChatTransport } from './custom-chat-transport'
import type { AgentStreamChunk, AgentStreamSendResult } from '../../../shared/types'

// 捕获 window.api.agent 注册的流监听器，用来在 streamSend 期间模拟主进程逐 chunk 推送 + 结束
let chunkListener: ((chunk: AgentStreamChunk) => void) | null = null
let endListener: ((result: AgentStreamSendResult) => void) | null = null

const CHUNKS: UIMessageChunk[] = [
  { type: 'start', messageId: 'a-1' },
  { type: 'reasoning-start', id: 'r-1' },
  { type: 'reasoning-delta', id: 'r-1', delta: '我在思考' },
  { type: 'reasoning-delta', id: 'r-1', delta: '怎么做。' },
  { type: 'reasoning-end', id: 'r-1' },
  { type: 'text-start', id: 't-1' },
  { type: 'text-delta', id: 't-1', delta: '你好' },
  { type: 'text-delta', id: 't-1', delta: '，世界' },
  { type: 'text-end', id: 't-1' },
  { type: 'finish', finishReason: 'stop' }
]

const RESULT: AgentStreamSendResult = { ok: true, content: '你好，世界', reasoning: '我在思考怎么做。' }

beforeEach(() => {
  chunkListener = null
  endListener = null
  // 监听器注册后，streamSend 同步推送完整 chunk 序列再结束，模拟主进程消费完 toUIMessageStream 后的推送
  Object.defineProperty(window, 'api', {
    value: {
      agent: {
        streamSend: vi.fn(async () => {
          for (const c of CHUNKS) chunkListener?.(c as AgentStreamChunk)
          endListener?.(RESULT)
          return RESULT
        }),
        onStreamChunk: vi.fn((cb) => {
          chunkListener = cb
          return () => {
            chunkListener = null
          }
        }),
        onStreamEnd: vi.fn((cb) => {
          endListener = cb
          return () => {
            endListener = null
          }
        }),
        abort: vi.fn()
      }
    },
    configurable: true
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).api
})

describe('ElectronChatTransport（方案 B 阶段 A）', () => {
  it('将主进程推送的 UIMessageChunk 拼成 useChat 可消费的流，parts 含 reasoning 与 text', async () => {
    const transport = new ElectronChatTransport()
    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: 'c-1',
      messageId: undefined,
      messages: [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: '你好' }] }],
      abortSignal: undefined
    })

    let last: unknown
    for await (const snap of readUIMessageStream({ stream })) last = snap
    const msg = last as { id: string; parts: Array<{ type: string; text?: string; state?: string }> }

    expect(msg.id).toBe('a-1')
    const reasoning = msg.parts.find((p) => p.type === 'reasoning')
    const text = msg.parts.find((p) => p.type === 'text')
    // 阶段 A 关键验收：reasoning part 透传成功
    expect(reasoning?.text).toBe('我在思考怎么做。')
    expect(reasoning?.state).toBe('done')
    expect(text?.text).toBe('你好，世界')
    expect(text?.state).toBe('done')
  })

  it('主进程返回 error 时，流以 error chunk 收尾供 useChat 呈现', async () => {
    ;(window.api.agent.streamSend as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      endListener?.({ ok: false, error: '模型超时' })
      return { ok: false, error: '模型超时' }
    })

    const transport = new ElectronChatTransport()
    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: 'c-1',
      messageId: undefined,
      messages: [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: '你好' }] }],
      abortSignal: undefined
    })

    const received: UIMessageChunk[] = []
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received.push(value)
    }
    expect(received[received.length - 1]).toMatchObject({ type: 'error', errorText: '模型超时' })
  })
})
