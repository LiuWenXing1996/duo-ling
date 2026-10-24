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
  type SwMessage,
  type WireResult,
} from './protocol'

type Handler = (message: SwMessage) => unknown | Promise<unknown>

type EventSubscriber = (tabId: number, scriptId: string, type: string, data: unknown) => void

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  key: string
}

export class ServiceWorkerMessenger {
  static #instance: ServiceWorkerMessenger | undefined

  static get instance(): ServiceWorkerMessenger {
    return (ServiceWorkerMessenger.#instance ??= new ServiceWorkerMessenger())
  }

  readonly #handlers = new Map<string, Handler>()
  readonly #pending = new Map<number, PendingRequest>()
  readonly #ports = new Map<string, chrome.runtime.Port>()
  readonly #onPortClosed = new Set<(tabId: number, scriptId: string) => void>()
  readonly #onEvent = new Set<EventSubscriber>()
  #seq = Math.floor(Math.random() * 1_000_000) + 1

  private constructor() {
    const onConnect = chrome.runtime.onUserScriptConnect
    if (typeof onConnect?.addListener !== 'function') {
      console.warn('[dl-messaging] runtime.onUserScriptConnect 不可用，SW 侧消息通道未挂载')
      return
    }

    onConnect.addListener((port) => {
      if (port.name !== MESSAGING_PORT) return
      const sender = port.sender
      const tabId = sender?.tab?.id
      const scriptId = (sender as { userScript?: { scriptId?: string } }).userScript?.scriptId
      if (tabId !== undefined && scriptId) this.#ports.set(`${tabId}:${scriptId}`, port)
      port.onMessage.addListener((raw: unknown) => {
        void this.#serve(raw, port, sender)
      })
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError
        for (const [portKey, known] of this.#ports) {
          if (known !== port) continue
          this.#ports.delete(portKey)
          const cut = portKey.indexOf(':')
          const closedTabId = Number(portKey.slice(0, cut))
          const closedScriptId = portKey.slice(cut + 1)
          for (const [id, entry] of this.#pending) {
            if (entry.key !== portKey) continue
            this.#pending.delete(id)
            entry.reject(
              new MessagingError(
                'TRANSPORT',
                `脚本 ${closedScriptId} 在 tab ${closedTabId} 的端口已断开`,
              ),
            )
          }
          for (const listener of this.#onPortClosed) listener(closedTabId, closedScriptId)
        }
      })
    })
  }

  onMessage(type: string, handler: Handler): () => void {
    if (this.#handlers.has(type)) {
      throw new MessagingError('PROTOCOL', `同一上下文内同一类型只能注册一个处理器：${type}`)
    }
    this.#handlers.set(type, handler)
    return () => {
      this.#handlers.delete(type)
    }
  }

  onPortClosed(listener: (tabId: number, scriptId: string) => void): () => void {
    this.#onPortClosed.add(listener)
    return () => {
      this.#onPortClosed.delete(listener)
    }
  }

  onEvent(listener: EventSubscriber): () => void {
    this.#onEvent.add(listener)
    return () => {
      this.#onEvent.delete(listener)
    }
  }

  sendToScript(tabId: number, scriptId: string, type: string, data?: unknown): Promise<unknown> {
    const key = `${tabId}:${scriptId}`
    const port = this.#ports.get(key)
    if (!port) {
      return Promise.reject(
        new MessagingError('TRANSPORT', `脚本 ${scriptId} 在 tab ${tabId} 上没有连接`),
      )
    }

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
      this.#pending.set(id, { resolve, reject, key })
      try {
        port.postMessage(request)
      } catch {
        this.#pending.delete(id)
        reject(new MessagingError('TRANSPORT', `向脚本 ${scriptId} 发送失败，端口已断开`))
      }
    })
  }

  tabIdsOf(scriptId: string): number[] {
    const tabIds: number[] = []
    for (const key of this.#ports.keys()) {
      const cut = key.indexOf(':')
      if (key.slice(cut + 1) === scriptId) tabIds.push(Number(key.slice(0, cut)))
    }
    return tabIds
  }

  emit(tabId: number, scriptId: string, type: string, data?: unknown): void {
    const port = this.#ports.get(`${tabId}:${scriptId}`)
    if (!port) return
    const detail: EventDetail = { channel: MESSAGING_CHANNEL, kind: 'event', type, scriptId, data }
    try {
      port.postMessage(detail)
    } catch {
      return
    }
  }

  async #serve(
    raw: unknown,
    port: chrome.runtime.Port,
    sender: chrome.runtime.MessageSender | undefined,
  ): Promise<void> {
    const kind = frameKind(raw)
    if (kind === 'response') {
      const frame = raw as ResponseDetail
      const pending = this.#pending.get(frame.id)
      if (!pending) return
      this.#pending.delete(frame.id)
      if (frame.ok) {
        pending.resolve(frame.res)
      } else {
        pending.reject(
          frame.err ? deserializeError(frame.err) : new Error(`消息 ${frame.type} 没有回包内容`),
        )
      }
      return
    }
    if (kind === 'event') {
      const frame = raw as EventDetail
      const eventTabId = sender?.tab?.id
      if (eventTabId === undefined) return
      for (const listener of this.#onEvent)
        listener(eventTabId, frame.scriptId, frame.type, frame.data)
      return
    }
    if (kind !== 'request') return

    const frame = raw as RequestDetail
    const tabId = sender?.tab?.id
    if (tabId !== undefined) this.#ports.set(`${tabId}:${frame.scriptId}`, port)

    const reply = (result: WireResult): void => {
      const response: ResponseDetail = {
        channel: MESSAGING_CHANNEL,
        kind: 'response',
        id: frame.id,
        type: frame.type,
        scriptId: frame.scriptId,
        ...result,
      }
      try {
        port.postMessage(response)
      } catch {}
    }

    const handler = this.#handlers.get(frame.type)
    if (!handler) {
      reply(wireError(new MessagingError('NO_HANDLER', `SW 侧没有注册处理器：${frame.type}`)))
      return
    }
    try {
      const res = await handler({
        ...frame,
        sender: sender ?? ({} as chrome.runtime.MessageSender),
      })
      reply({ ok: true, res })
    } catch (error) {
      reply(wireError(error))
    }
  }
}
