import {
  MESSAGING_CHANNEL,
  MESSAGING_PORT,
  MessagingError,
  assertSerializable,
  isRequestDetail,
  wireError,
  type ResponseDetail,
  type SwMessage,
  type WireResult,
} from './protocol'

type Handler = (message: SwMessage) => unknown | Promise<unknown>

export class ServiceWorkerMessenger {
  readonly #handlers = new Map<string, Handler>()

  constructor() {
    const onConnect = chrome.runtime.onUserScriptConnect
    if (typeof onConnect?.addListener !== 'function') {
      console.warn('[dl-messaging] runtime.onUserScriptConnect 不可用，SW 侧消息通道未挂载')
      return
    }

    onConnect.addListener((port) => {
      if (port.name !== MESSAGING_PORT) return
      const sender = port.sender
      port.onMessage.addListener((raw: unknown) => {
        void this.#serve(raw, port, sender)
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

  async #serve(
    raw: unknown,
    port: chrome.runtime.Port,
    sender: chrome.runtime.MessageSender | undefined,
  ): Promise<void> {
    if (!isRequestDetail(raw)) return

    const { instanceId, message } = raw
    const reply = (result: WireResult): void => {
      const frame: ResponseDetail = {
        channel: MESSAGING_CHANNEL,
        instanceId,
        id: message.id,
        type: message.type,
        ...result,
      }
      try {
        port.postMessage(frame)
      } catch {
        // 页面已卸载 / 端口已断：没人等这个回包了
      }
    }

    const handler = this.#handlers.get(message.type)
    if (!handler) {
      reply(wireError(new MessagingError('NO_HANDLER', `SW 侧没有注册处理器：${message.type}`)))
      return
    }

    try {
      const res = await handler({
        ...message,
        sender: sender ?? ({} as chrome.runtime.MessageSender),
      })
      assertSerializable(res, 'result')
      reply({ ok: true, res })
    } catch (error) {
      reply(wireError(error))
    }
  }
}
