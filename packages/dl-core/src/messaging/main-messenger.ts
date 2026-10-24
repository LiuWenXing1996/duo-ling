import {
  MESSAGING_CHANNEL,
  MESSAGING_RELAY_READY_ATTR,
  MessagingError,
  deserializeError,
  frameKind,
  wireError,
  type EventDetail,
  type RequestDetail,
  type ResponseDetail,
  type WireResult,
} from './protocol'

const RELAY_WAIT_MS = 10_000
const RELAY_POLL_MS = 50

function relayReady(): boolean {
  try {
    return document.documentElement?.hasAttribute(MESSAGING_RELAY_READY_ATTR) === true
  } catch {
    return false
  }
}

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
  #link: MessagePort | null = null
  readonly #queue: RequestDetail[] = []
  #relayTimer: ReturnType<typeof setTimeout> | null = null

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

  onEvent(type: string, handler: (data: unknown) => void): () => void {
    const handlers = this.#eventHandlers.get(type) ?? new Set<(data: unknown) => void>()
    this.#eventHandlers.set(type, handlers)
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
      if (handlers.size === 0) this.#eventHandlers.delete(type)
    }
  }

  // 中继件没就位时先攒着：同为 document_start，谁先跑不归我们管，此刻发出去的首帧会连端口一起落空
  #post(frame: RequestDetail): void {
    if (this.#link) {
      this.#link.postMessage(frame)
      return
    }
    if (!relayReady()) {
      this.#queue.push(frame)
      this.#watchRelay()
      return
    }
    this.#openLink([frame])
  }

  #openLink(frames: RequestDetail[]): void {
    const [first, ...rest] = frames
    if (!first) return
    if (this.#link) {
      this.#drain(this.#link, frames)
      return
    }
    const channel = new MessageChannel()
    const link = channel.port1
    this.#link = link
    link.addEventListener('message', (event: MessageEvent) => this.#dispatch(event.data))
    link.start()
    window.postMessage(first, '*', [channel.port2])
    this.#drain(link, rest)
  }

  #drain(link: MessagePort, frames: RequestDetail[]): void {
    for (const queued of frames) {
      try {
        link.postMessage(queued)
      } catch {}
    }
  }

  #watchRelay(): void {
    if (this.#relayTimer !== null) return
    const deadline = Date.now() + RELAY_WAIT_MS
    const tick = (): void => {
      this.#relayTimer = null
      if (this.#link) {
        this.#openLink(this.#queue.splice(0))
        return
      }
      if (relayReady()) {
        this.#openLink(this.#queue.splice(0))
        return
      }
      if (Date.now() >= deadline) {
        this.#rejectQueue('中继件没有在本页就位：主世界的脚本连不上后台')
        return
      }
      this.#relayTimer = setTimeout(tick, RELAY_POLL_MS)
    }
    this.#relayTimer = setTimeout(tick, RELAY_POLL_MS)
  }

  #rejectQueue(reason: string): void {
    for (const frame of this.#queue.splice(0)) {
      const entry = this.#pending.get(frame.id)
      if (!entry) continue
      this.#pending.delete(frame.id)
      entry.reject(new MessagingError('TRANSPORT', reason))
    }
  }

  #dropLink(reason: string): void {
    const link = this.#link
    if (!link) return
    this.#link = null
    this.#queue.length = 0
    try {
      link.close()
    } catch {}
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of pending) entry.reject(new MessagingError('TRANSPORT', reason))
  }

  #dispatch(raw: unknown): void {
    const kind = frameKind(raw)
    if (kind === 'disconnect') {
      this.#dropLink('与后台的连接已断开，请重试')
      return
    }
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
