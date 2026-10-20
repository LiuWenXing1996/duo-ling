import {
  MESSAGING_CHANNEL,
  MESSAGING_PORT,
  frameKind,
  type DisconnectDetail,
  type RequestDetail,
} from './protocol'

export class MessagingRelay {
  static readonly instance = new MessagingRelay()

  static readonly #RECONNECT_MIN_MS = 1_000
  static readonly #RECONNECT_MAX_MS = 15_000

  #port: chrome.runtime.Port | null = null
  #links = new Map<string, MessagePort>()
  #attempt = 0
  #queue: RequestDetail[] = []

  private constructor() {}

  mount(): void {
    window.addEventListener('message', (event: MessageEvent) => this.#onWindowMessage(event))
    this.#open()
  }

  #open(): void {
    if (this.#port) return
    let next: chrome.runtime.Port
    try {
      next = chrome.runtime.connect({ name: MESSAGING_PORT })
    } catch {
      this.#schedule()
      return
    }
    this.#port = next
    next.onMessage.addListener((raw: unknown) => {
      const kind = frameKind(raw)
      if (kind !== 'response' && kind !== 'request' && kind !== 'disconnect') return
      this.#attempt = 0
      if (kind === 'disconnect') {
        for (const link of this.#links.values()) link.postMessage(raw)
        return
      }
      this.#links.get((raw as { scriptId: string }).scriptId)?.postMessage(raw)
    })
    next.onDisconnect.addListener(() => {
      void chrome.runtime.lastError
      if (this.#port !== next) return
      this.#port = null
      const detail: DisconnectDetail = { channel: MESSAGING_CHANNEL, kind: 'disconnect' }
      for (const link of this.#links.values()) link.postMessage(detail)
      this.#schedule()
    })
    this.#flush()
  }

  #schedule(): void {
    const backoff = MessagingRelay.#RECONNECT_MIN_MS * 2 ** this.#attempt++
    setTimeout(() => this.#open(), Math.min(backoff, MessagingRelay.#RECONNECT_MAX_MS))
  }

  #flush(): void {
    while (this.#queue.length > 0) {
      const port = this.#port
      if (!port) return
      try {
        port.postMessage(this.#queue[0])
      } catch {
        return
      }
      this.#queue.shift()
    }
  }

  #accept(detail: RequestDetail): void {
    this.#queue.push(detail)
    this.#open()
    this.#flush()
  }

  #onWindowMessage(event: MessageEvent): void {
    if (frameKind(event.data) !== 'request') return
    const [next] = event.ports
    if (!next) return
    const detail = event.data as RequestDetail
    const key = detail.scriptId
    this.#links.get(key)?.close()
    this.#links.set(key, next)
    next.onmessage = (messageEvent: MessageEvent) => {
      if (frameKind(messageEvent.data) !== 'event') {
        this.#accept(messageEvent.data as RequestDetail)
        return
      }
      try {
        this.#port?.postMessage(messageEvent.data)
      } catch {
        return
      }
    }
    this.#accept(detail)
  }
}
