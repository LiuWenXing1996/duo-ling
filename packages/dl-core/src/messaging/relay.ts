import {
  MESSAGING_DISCONNECT_EVENT,
  MESSAGING_PORT,
  MESSAGING_REQUEST_EVENT,
  MESSAGING_RESPONSE_EVENT,
  isRequestDetail,
  isResponseDetail,
  type RequestDetail,
  type ResponseDetail,
} from './protocol'

declare global {
  interface Window {
    __dlMessagingRelay?: boolean
  }
}

const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 15_000

const getRuntime = (): typeof chrome.runtime | null => {
  try {
    const api = (globalThis as { chrome?: typeof chrome }).chrome
    return api?.runtime && typeof api.runtime.connect === 'function' ? api.runtime : null
  } catch {
    return null
  }
}

export function mountMessagingRelay(): void {
  if (window.__dlMessagingRelay) return
  window.__dlMessagingRelay = true

  let port: chrome.runtime.Port | null = null
  let attempt = 0
  const queue: RequestDetail[] = []

  const schedule = (): void => {
    setTimeout(open, Math.min(RECONNECT_MIN_MS * 2 ** attempt++, RECONNECT_MAX_MS))
  }

  const flush = (): void => {
    while (port && queue.length > 0) {
      try {
        port.postMessage(queue[0])
      } catch {
        return
      }
      queue.shift()
    }
  }

  function open(): void {
    if (port) return
    const runtime = getRuntime()
    if (!runtime) {
      schedule()
      return
    }
    let next: chrome.runtime.Port
    try {
      next = runtime.connect({ name: MESSAGING_PORT })
    } catch {
      schedule()
      return
    }
    port = next
    next.onMessage.addListener((raw: unknown) => {
      if (!isResponseDetail(raw)) return
      attempt = 0
      window.dispatchEvent(new CustomEvent<ResponseDetail>(MESSAGING_RESPONSE_EVENT, { detail: raw }))
    })
    next.onDisconnect.addListener(() => {
      void runtime.lastError
      if (port !== next) return
      port = null
      window.dispatchEvent(new CustomEvent(MESSAGING_DISCONNECT_EVENT))
      schedule()
    })
    flush()
  }

  window.addEventListener(MESSAGING_REQUEST_EVENT, (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail
    if (!isRequestDetail(detail)) return
    queue.push(detail)
    open()
    flush()
  })

  open()
}
