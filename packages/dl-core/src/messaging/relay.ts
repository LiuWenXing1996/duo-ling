import {
  MESSAGING_CHANNEL,
  MESSAGING_REQUEST_EVENT,
  MESSAGING_RESPONSE_EVENT,
  MessagingError,
  isRequestDetail,
  isWireResult,
  wireError,
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

const getRuntime = (): typeof chrome.runtime | null => {
  try {
    const api = (globalThis as { chrome?: typeof chrome }).chrome
    return api?.runtime && typeof api.runtime.sendMessage === 'function' ? api.runtime : null
  } catch {
    return null
  }
}

export function mountMessagingRelay(): void {
  if (window.__dlMessagingRelay) return
  window.__dlMessagingRelay = true

  const respond = (detail: RequestDetail, result: WireResult): void => {
    const response: ResponseDetail = {
      channel: MESSAGING_CHANNEL,
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

    const runtime = getRuntime()
    if (!runtime) {
      respond(
        detail,
        wireError(new MessagingError('TRANSPORT', '中继件拿不到扩展 API：脚本世界未开启 messaging')),
      )
      return
    }

    const request: RuntimeRequest = { channel: MESSAGING_CHANNEL, message: detail.message }

    try {
      runtime.sendMessage(request, (response?: unknown) => {
        const lastError = runtime.lastError?.message
        if (lastError) {
          respond(detail, wireError(new MessagingError('TRANSPORT', lastError)))
          return
        }
        if (!isWireResult(response)) {
          respond(
            detail,
            wireError(new MessagingError('PROTOCOL', `回包不符合消息通道信封：${detail.message.type}`)),
          )
          return
        }
        respond(detail, response)
      })
    } catch (error) {
      respond(detail, wireError(error))
    }
  })
}
