import {
  MESSAGING_CHANNEL,
  MESSAGING_REQUEST_EVENT,
  MESSAGING_RESPONSE_EVENT,
  MessagingError,
  isRequestDetail,
  isWireResult,
  serializeError,
  type RequestDetail,
  type ResponseDetail,
  type RuntimeRequest,
  type WireResult,
} from './protocol'

declare global {
  interface Window {
    __dlMessagingRelay?: boolean
  }
}

export interface MessagingRelayOptions {
  namespaces?: readonly string[]
}

const unavailable = (why: string): WireResult => ({
  ok: false,
  err: serializeError(new MessagingError('TRANSPORT', why)),
})

const getRuntime = (): typeof chrome.runtime | null => {
  try {
    const api = (globalThis as { chrome?: typeof chrome }).chrome
    return api?.runtime && typeof api.runtime.sendMessage === 'function' ? api.runtime : null
  } catch {
    return null
  }
}

export function mountMessagingRelay(options: MessagingRelayOptions = {}): void {
  if (window.__dlMessagingRelay) return
  window.__dlMessagingRelay = true

  const allowed = options.namespaces

  const respond = (detail: RequestDetail, result: WireResult): void => {
    const response: ResponseDetail = {
      channel: MESSAGING_CHANNEL,
      namespace: detail.namespace,
      instanceId: detail.instanceId,
      id: detail.message.id,
      type: detail.message.type,
      ...result,
    }
    window.dispatchEvent(new CustomEvent<ResponseDetail>(MESSAGING_RESPONSE_EVENT, { detail: response }))
  }

  window.addEventListener(MESSAGING_REQUEST_EVENT, (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail
    if (!isRequestDetail(detail)) return
    if (allowed && !allowed.includes(detail.namespace)) return

    const runtime = getRuntime()
    if (!runtime) {
      respond(detail, unavailable('中继件拿不到扩展 API：脚本世界未开启 messaging'))
      return
    }

    const request: RuntimeRequest = {
      channel: MESSAGING_CHANNEL,
      namespace: detail.namespace,
      message: detail.message,
    }

    try {
      runtime.sendMessage(request, (response?: unknown) => {
        const lastError = runtime.lastError?.message
        if (lastError) {
          respond(detail, unavailable(lastError))
          return
        }
        if (!isWireResult(response)) {
          respond(
            detail,
            {
              ok: false,
              err: serializeError(
                new MessagingError('PROTOCOL', `回包不符合消息通道信封：${detail.message.type}`),
              ),
            },
          )
          return
        }
        respond(detail, response)
      })
    } catch (error) {
      respond(detail, { ok: false, err: serializeError(error) })
    }
  })
}
