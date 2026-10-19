import {
  DEFAULT_NAMESPACE,
  MESSAGING_CHANNEL,
  MESSAGING_REQUEST_EVENT,
  MESSAGING_RESPONSE_EVENT,
  assertSerializable,
  deserializeError,
  isResponseDetail,
  type GetDataType,
  type GetReturnType,
  type ProtocolMap,
  type RequestDetail,
  type WireMessage,
} from './protocol'

export interface MainWorldMessagingOptions {
  namespace?: string
  scriptId?: string
}

export type SendArgs<TProtocolMap extends ProtocolMap, TType extends keyof TProtocolMap> =
  GetDataType<TProtocolMap[TType]> extends undefined
    ? [data?: GetDataType<TProtocolMap[TType]>]
    : [data: GetDataType<TProtocolMap[TType]>]

export interface MainWorldMessenger<TProtocolMap extends ProtocolMap> {
  sendMessage<TType extends keyof TProtocolMap>(
    type: TType,
    ...args: SendArgs<TProtocolMap, TType>
  ): Promise<GetReturnType<TProtocolMap[TType]>>
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

let instanceSeed = 0

class MainWorldMessengerImpl<TProtocolMap extends ProtocolMap>
  implements MainWorldMessenger<TProtocolMap>
{
  readonly #namespace: string
  readonly #scriptId: string | undefined
  readonly #instanceId: string
  readonly #pending = new Map<number, PendingRequest>()
  #seq = Math.floor(Math.random() * 1_000_000) + 1
  #listening = false

  constructor(options: MainWorldMessagingOptions) {
    this.#namespace = options.namespace ?? DEFAULT_NAMESPACE
    this.#scriptId = options.scriptId || undefined
    this.#instanceId = [
      Date.now().toString(36),
      (instanceSeed++).toString(36),
      Math.random().toString(36).slice(2, 8),
    ].join('-')
  }

  async sendMessage<TType extends keyof TProtocolMap>(
    type: TType,
    ...args: SendArgs<TProtocolMap, TType>
  ): Promise<GetReturnType<TProtocolMap[TType]>> {
    const data = args[0] as unknown
    assertSerializable(data, 'data')

    const id = ++this.#seq
    const message: WireMessage = { id, type: String(type), data, timestamp: Date.now() }
    if (this.#scriptId) message.scriptId = this.#scriptId

    this.#ensureResponseListener()

    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      const detail: RequestDetail = {
        channel: MESSAGING_CHANNEL,
        namespace: this.#namespace,
        instanceId: this.#instanceId,
        message,
      }
      window.dispatchEvent(new CustomEvent<RequestDetail>(MESSAGING_REQUEST_EVENT, { detail }))
    })

    return result as Promise<GetReturnType<TProtocolMap[TType]>>
  }

  #ensureResponseListener(): void {
    if (this.#listening) return
    this.#listening = true
    window.addEventListener(MESSAGING_RESPONSE_EVENT, (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail
      if (!isResponseDetail(detail)) return
      if (detail.namespace !== this.#namespace) return
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

export function defineMainWorldMessaging<TProtocolMap extends ProtocolMap = ProtocolMap>(
  options: MainWorldMessagingOptions = {},
): MainWorldMessenger<TProtocolMap> {
  return new MainWorldMessengerImpl<TProtocolMap>(options)
}
