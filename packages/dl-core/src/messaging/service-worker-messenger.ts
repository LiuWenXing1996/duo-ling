import {
  MessagingError,
  assertSerializable,
  isRuntimeRequest,
  wireError,
  type SwMessage,
} from './protocol'

type Handler = (message: SwMessage) => unknown | Promise<unknown>

export class ServiceWorkerMessenger {
  readonly #handlers = new Map<string, Handler>()

  constructor() {
    // userScripts 世界发出的消息只进 onUserScriptMessage，通用 onMessage 收不到
    const onScriptMessage = chrome.runtime.onUserScriptMessage
    if (typeof onScriptMessage?.addListener !== 'function') {
      console.warn('[dl-messaging] runtime.onUserScriptMessage 不可用，SW 侧消息通道未挂载')
      return
    }

    onScriptMessage.addListener((raw, sender, sendResponse) => {
      if (!isRuntimeRequest(raw)) return undefined

      const message = raw.message
      const handler = this.#handlers.get(message.type)
      if (!handler) {
        sendResponse(wireError(new MessagingError('NO_HANDLER', `SW 侧没有注册处理器：${message.type}`)))
        return undefined
      }

      void Promise.resolve()
        .then(() => handler({ ...message, sender }))
        .then((res) => {
          try {
            assertSerializable(res, 'result')
          } catch (error) {
            sendResponse(wireError(error))
            return
          }
          sendResponse({ ok: true, res })
        })
        .catch((error: unknown) => sendResponse(wireError(error)))
      return true
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
}
