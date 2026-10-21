import {
  MESSAGING_CHANNEL,
  MESSAGING_PORT,
  MessagingError,
  deserializeError,
  frameKind,
  wireError,
  type EventDetail,
  type RequestDetail,
  type ResponseDetail,
  type WireResult,
} from './protocol'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type Handler = (data: unknown) => unknown | Promise<unknown>

export class MainWorldMessenger {
  static readonly instance = new MainWorldMessenger()

  static #scriptId: string | undefined

  static setScriptId(id: string): void {
    const next = id || undefined
    const current = MainWorldMessenger.#scriptId
    if (current === next) return
    if (current !== undefined) {
      throw new MessagingError(
        'PROTOCOL',
        `scriptId 已占位（${current}），不能再改成 ${next ?? '空'}`,
      )
    }
    MainWorldMessenger.#scriptId = next
  }

  readonly #pending = new Map<number, PendingRequest>()
  readonly #handlers = new Map<string, Handler>()
  readonly #eventHandlers = new Map<string, Set<(data: unknown) => void>>()
  #seq = Math.floor(Math.random() * 1_000_000) + 1
  #link: chrome.runtime.Port | null = null

  private constructor() {}

  sendMessage(type: string, data?: unknown): Promise<unknown> {
    const scriptId = MainWorldMessenger.#scriptId
    if (!scriptId) throw new MessagingError('PROTOCOL', '发送前没有注入 scriptId')

    const id = ++this.#seq
    const request: RequestDetail = {
      channel: MESSAGING_CHANNEL,
      kind: 'request',
      id,
      type,
      scriptId,
      data,
    }

    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      try {
        this.#post(request)
      } catch (error) {
        this.#pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  emit(type: string, data?: unknown): void {
    const scriptId = MainWorldMessenger.#scriptId
    const link = this.#link
    if (!scriptId || !link) return
    const detail: EventDetail = { channel: MESSAGING_CHANNEL, kind: 'event', type, scriptId, data }
    try {
      link.postMessage(detail)
    } catch {
      return
    }
  }

  onRequest(type: string, handler: Handler): () => void {
    if (this.#handlers.has(type)) {
      throw new MessagingError('PROTOCOL', `同一脚本内同一类型只能注册一个处理器：${type}`)
    }
    this.#handlers.set(type, handler)
    return () => {
      this.#handlers.delete(type)
    }
  }

  /** 订阅 SW 下发的事件；同类型可挂多个，取消时按函数引用删 */
  onEvent(type: string, handler: (data: unknown) => void): () => void {
    const handlers = this.#eventHandlers.get(type) ?? new Set<(data: unknown) => void>()
    this.#eventHandlers.set(type, handlers)
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
      if (handlers.size === 0) this.#eventHandlers.delete(type)
    }
  }

  #post(frame: RequestDetail): void {
    if (this.#link) {
      this.#link.postMessage(frame)
      return
    }
    const port = chrome.runtime.connect({ name: MESSAGING_PORT })
    this.#link = port
    port.onMessage.addListener((raw: unknown) => this.#dispatch(raw))
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError
      if (this.#link !== port) return
      this.#link = null
      const pending = [...this.#pending.values()]
      this.#pending.clear()
      for (const entry of pending) {
        entry.reject(new MessagingError('TRANSPORT', '与后台的连接已断开，请重试'))
      }
    })
    port.postMessage(frame)
  }

  #dispatch(raw: unknown): void {
    const kind = frameKind(raw)
    if (kind === 'request') {
      void this.#serve(raw as RequestDetail)
      return
    }
    if (kind === 'event') {
      const frame = raw as EventDetail
      for (const handler of this.#eventHandlers.get(frame.type) ?? []) {
        try {
          handler(frame.data)
        } catch (error) {
          console.error(`[dl-messaging] 事件 ${frame.type} 的处理器抛错`, error)
        }
      }
      return
    }
    if (kind !== 'response') return

    const frame = raw as ResponseDetail
    const pending = this.#pending.get(frame.id)
    if (!pending) return
    this.#pending.delete(frame.id)

    if (frame.ok) {
      pending.resolve(frame.res)
      return
    }
    pending.reject(
      frame.err ? deserializeError(frame.err) : new Error(`消息 ${frame.type} 没有回包内容`),
    )
  }

  async #serve(frame: RequestDetail): Promise<void> {
    const reply = (result: WireResult): void => {
      const response: ResponseDetail = {
        channel: MESSAGING_CHANNEL,
        kind: 'response',
        id: frame.id,
        type: frame.type,
        scriptId: frame.scriptId,
        ...result,
      }
      this.#link?.postMessage(response)
    }

    const handler = this.#handlers.get(frame.type)
    if (!handler) {
      reply(wireError(new MessagingError('NO_HANDLER', `脚本侧没有注册处理器：${frame.type}`)))
      return
    }

    try {
      reply({ ok: true, res: await handler(frame.data) })
    } catch (error) {
      reply(wireError(error))
    }
  }
}
