import {
  DEFAULT_NAMESPACE,
  MessagingError,
  assertSerializable,
  isRuntimeRequest,
  serializeError,
  type GetReturnType,
  type MaybePromise,
  type ProtocolMap,
  type ServiceWorkerMessage,
} from './protocol'

export interface ServiceWorkerMessagingOptions {
  namespace?: string
}

export interface ServiceWorkerMessenger<TProtocolMap extends ProtocolMap> {
  onMessage<TType extends keyof TProtocolMap>(
    type: TType,
    handler: (
      message: ServiceWorkerMessage<TProtocolMap, TType>,
    ) => MaybePromise<GetReturnType<TProtocolMap[TType]>>,
  ): () => void
  removeAllListeners(): void
}

type AnyHandler = (message: ServiceWorkerMessage<ProtocolMap, string>) => MaybePromise<unknown>

class ServiceWorkerMessengerImpl<TProtocolMap extends ProtocolMap>
  implements ServiceWorkerMessenger<TProtocolMap>
{
  readonly #namespace: string
  readonly #handlers = new Map<string, AnyHandler>()

  constructor(namespace: string) {
    this.#namespace = namespace

    // userScripts 世界发出的消息只进 onUserScriptMessage，通用 onMessage 收不到
    const onScriptMessage = chrome.runtime.onUserScriptMessage
    if (typeof onScriptMessage?.addListener !== 'function') {
      console.warn('[dl-messaging] runtime.onUserScriptMessage 不可用，SW 侧消息通道未挂载')
      return
    }

    onScriptMessage.addListener((raw, sender, sendResponse) => {
      if (!isRuntimeRequest(raw)) return undefined
      if (raw.namespace !== this.#namespace) return undefined

      const message = raw.message
      const handler = this.#handlers.get(message.type)
      if (!handler) {
        sendResponse({
          ok: false,
          err: serializeError(
            new MessagingError('NO_HANDLER', `SW 侧没有注册处理器：${message.type}`),
          ),
        })
        return undefined
      }

      const full = {
        ...message,
        namespace: raw.namespace,
        sender,
      } as ServiceWorkerMessage<ProtocolMap, string>

      void Promise.resolve()
        .then(() => handler(full))
        .then((res) => {
          try {
            assertSerializable(res, 'result')
          } catch (error) {
            sendResponse({ ok: false, err: serializeError(error) })
            return
          }
          sendResponse({ ok: true, res })
        })
        .catch((error: unknown) => {
          sendResponse({ ok: false, err: serializeError(error) })
        })
      return true
    })
  }

  onMessage<TType extends keyof TProtocolMap>(
    type: TType,
    handler: (
      message: ServiceWorkerMessage<TProtocolMap, TType>,
    ) => MaybePromise<GetReturnType<TProtocolMap[TType]>>,
  ): () => void {
    const key = String(type)
    if (this.#handlers.has(key)) {
      throw new MessagingError('PROTOCOL', `同一上下文内同一类型只能注册一个处理器：${key}`)
    }
    this.#handlers.set(key, handler as unknown as AnyHandler)
    return () => {
      this.#handlers.delete(key)
    }
  }

  removeAllListeners(): void {
    this.#handlers.clear()
  }
}

const instances = new Map<string, ServiceWorkerMessengerImpl<ProtocolMap>>()

export function mountServiceWorkerMessaging<TProtocolMap extends ProtocolMap = ProtocolMap>(
  options: ServiceWorkerMessagingOptions = {},
): ServiceWorkerMessenger<TProtocolMap> {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE
  let instance = instances.get(namespace)
  if (!instance) {
    instance = new ServiceWorkerMessengerImpl<ProtocolMap>(namespace)
    instances.set(namespace, instance)
  }
  return instance as unknown as ServiceWorkerMessenger<TProtocolMap>
}
