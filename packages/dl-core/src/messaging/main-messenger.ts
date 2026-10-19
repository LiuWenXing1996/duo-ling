import {
  MESSAGING_CHANNEL,
  MESSAGING_REQUEST_EVENT,
  MESSAGING_RESPONSE_EVENT,
  assertSerializable,
  deserializeError,
  isResponseDetail,
  type RequestDetail,
  type WireMessage,
} from './protocol'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

let instanceSeed = 0

export class MainWorldMessenger {
  readonly #scriptId: string | undefined
  readonly #instanceId: string
  readonly #pending = new Map<number, PendingRequest>()
  #seq = Math.floor(Math.random() * 1_000_000) + 1
  #listening = false

  constructor({ scriptId }: { scriptId?: string } = {}) {
    this.#scriptId = scriptId || undefined
    this.#instanceId = [
      Date.now().toString(36),
      (instanceSeed++).toString(36),
      Math.random().toString(36).slice(2, 8),
    ].join('-')
  }

  async sendMessage(type: string, data?: unknown): Promise<unknown> {
    assertSerializable(data, 'data')

    const id = ++this.#seq
    const message: WireMessage = { id, type, data }
    if (this.#scriptId) message.scriptId = this.#scriptId

    this.#ensureResponseListener()

    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      const detail: RequestDetail = {
        channel: MESSAGING_CHANNEL,
        instanceId: this.#instanceId,
        message,
      }
      window.dispatchEvent(new CustomEvent<RequestDetail>(MESSAGING_REQUEST_EVENT, { detail }))
    })
  }

  #ensureResponseListener(): void {
    if (this.#listening) return
    this.#listening = true
    window.addEventListener(MESSAGING_RESPONSE_EVENT, (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail
      if (!isResponseDetail(detail)) return
      if (detail.instanceId !== this.#instanceId) return

      const pending = this.#pending.get(detail.id)
      if (!pending) return
      this.#pending.delete(detail.id)

      if (detail.ok) {
        pending.resolve(detail.res)
        return
      }
      pending.reject(
        detail.err ? deserializeError(detail.err) : new Error(`消息 ${detail.type} 没有回包内容`),
      )
    })
  }
}
