import {
  LINK_CHANNEL,
  LINK_PORT_NAME,
  LinkError,
  fromErrorData,
  isLinkFrame,
  toErrorData,
  type LinkFrame,
  type LinkRequestFrame,
} from './link-frame'

interface PortLike {
  name?: string
  postMessage(message: unknown): void
  disconnect(): void
  onMessage: { addListener(listener: (raw: unknown) => void): void }
  onDisconnect: { addListener(listener: () => void): void }
}

interface RuntimeLike {
  connect?: (info: { name: string }) => PortLike
  onConnect?: {
    addListener(listener: (port: PortLike) => void): void
    removeListener(listener: (port: PortLike) => void): void
  }
}

function runtime(): RuntimeLike | null {
  return (globalThis as { chrome?: { runtime?: RuntimeLike } }).chrome?.runtime ?? null
}

function unref(timer: unknown): void {
  ;(timer as { unref?: () => void }).unref?.()
}

export type LinkRole = 'sw' | 'offscreen'

export interface LinkContext {
  peer: LinkRole
}

export type LinkHandler = (payload: unknown, ctx: LinkContext) => unknown | Promise<unknown>
export type LinkHandlers = Record<string, LinkHandler>
export type LinkEventListener = (type: string, payload: unknown) => void

export interface LinkOptions {
  role: LinkRole
  handlers?: LinkHandlers

  portName?: string

  heartbeatMs?: number

  defaultTimeoutMs?: number
  backoffInitialMs?: number
  backoffMaxMs?: number

  onOpen?: () => void

  onClose?: () => void
}

interface Pending {
  resolve(value: unknown): void
  reject(error: unknown): void
  timer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_HEARTBEAT_MS = 5_000
const DEFAULT_BACKOFF_INITIAL_MS = 100
const DEFAULT_BACKOFF_MAX_MS = 5_000

const HELLO_TIMEOUT_MS = 5_000

export class Link {
  readonly role: LinkRole

  private readonly portName: string
  private readonly heartbeatMs: number
  private readonly defaultTimeoutMs: number
  private readonly backoffInitialMs: number
  private readonly backoffMaxMs: number
  private readonly handlers: LinkHandlers
  private readonly openHook?: () => void
  private readonly closeHook?: () => void
  private readonly instanceId = Math.random().toString(36).slice(2)
  private readonly startedAt = Date.now()

  private readonly pending = new Map<number, Pending>()
  private readonly readyWaiters = new Set<() => void>()
  private readonly eventListeners = new Set<LinkEventListener>()
  private readonly openListeners = new Set<() => void>()

  private port: PortLike | null = null
  private ready = false
  private seq = 0
  private attempt = 0
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatMisses = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connectListener: ((port: PortLike) => void) | null = null
  private disposed = false

  constructor(options: LinkOptions) {
    this.role = options.role
    this.portName = options.portName ?? LINK_PORT_NAME
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.backoffInitialMs = options.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS
    this.openHook = options.onOpen
    this.closeHook = options.onClose

    this.handlers = {
      ...options.handlers,
      'link:hello': () => this.handleHello(),
      'link:ping': () => ({ at: Date.now() }),
    }
  }

  get isOpen(): boolean {
    return this.ready && this.port !== null
  }

  open(): void {
    if (this.disposed || this.port) return
    const rt = runtime()
    if (!rt?.connect) return
    let port: PortLike
    try {
      port = rt.connect({ name: this.portName })
    } catch {
      this.scheduleReconnect()
      return
    }
    this.bind(port)

    void this.request(
      'link:hello',
      { role: this.role, instanceId: this.instanceId, startedAt: this.startedAt },
      { timeoutMs: HELLO_TIMEOUT_MS },
    )
      .then(() => this.markReady())
      .catch(() => {
        if (this.port === port) port.disconnect()
      })
  }

  accept(): void {
    const rt = runtime()
    if (!rt?.onConnect || this.connectListener) return
    this.connectListener = (port) => {
      if ((port.name ?? '') !== this.portName) return
      this.bind(port)

      const timer = setTimeout(() => {
        if (this.port === port && !this.ready) port.disconnect()
      }, HELLO_TIMEOUT_MS)
      unref(timer)
    }
    rt.onConnect.addListener(this.connectListener)
  }

  request<T = unknown>(type: string, payload?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    const port = this.port
    if (!port) {
      return Promise.reject(new LinkError('TRANSPORT', `链路未建立，无法发送 ${type}`))
    }
    const id = ++this.seq
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new LinkError('TIMEOUT', `链路请求超时（${timeoutMs}ms）：${type}`))
            }, timeoutMs)
          : null
      if (timer) unref(timer)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      const frame: LinkFrame = { ch: LINK_CHANNEL, t: 'req', id, type, payload }
      try {
        port.postMessage(frame)
      } catch (e) {
        this.settle(id)
        reject(new LinkError('TRANSPORT', `链路发送失败：${String(e)}`))
      }
    })
  }

  emit(type: string, payload?: unknown): boolean {
    const port = this.port
    if (!port || !this.ready) return false
    try {
      port.postMessage({ ch: LINK_CHANNEL, t: 'evt', type, payload })
      return true
    } catch {
      return false
    }
  }

  onEvent(listener: LinkEventListener): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener)
    return () => {
      this.openListeners.delete(listener)
    }
  }

  serve(type: string, handler: LinkHandler): () => void {
    const previous = this.handlers[type]
    this.handlers[type] = handler
    return () => {
      if (this.handlers[type] !== handler) return
      if (previous) this.handlers[type] = previous
      else delete this.handlers[type]
    }
  }

  whenReady(timeoutMs = HELLO_TIMEOUT_MS): Promise<void> {
    if (this.ready) return Promise.resolve()
    if (this.disposed) return Promise.reject(new LinkError('TRANSPORT', '链路已关闭'))
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const waiter = (): void => {
        if (timer) clearTimeout(timer)
        this.readyWaiters.delete(waiter)
        resolve()
      }
      this.readyWaiters.add(waiter)
      timer = setTimeout(() => {
        this.readyWaiters.delete(waiter)
        reject(new LinkError('TRANSPORT', `等待链路建立超时（${timeoutMs}ms）`))
      }, timeoutMs)
      unref(timer)
    })
  }

  close(): void {
    this.disposed = true
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const port = this.port
    this.port = null
    this.ready = false
    this.rejectAll(new LinkError('TRANSPORT', '链路已关闭'))
    if (port) {
      try {
        port.disconnect()
      } catch {}
    }
    const rt = runtime()
    if (this.connectListener && rt?.onConnect) {
      rt.onConnect.removeListener(this.connectListener)
    }
    this.connectListener = null
  }

  private bind(port: PortLike): void {
    const previous = this.port
    this.port = port
    this.ready = false
    if (previous && previous !== port) {
      try {
        previous.disconnect()
      } catch {}
    }
    port.onMessage.addListener((raw) => {
      if (this.port !== port) return
      if (!isLinkFrame(raw)) return
      this.receive(raw, port)
    })
    port.onDisconnect.addListener(() => this.onPortGone(port))
  }

  private onPortGone(port: PortLike): void {
    if (this.port !== port) return
    this.port = null
    this.ready = false
    this.stopHeartbeat()
    this.rejectAll(new LinkError('TRANSPORT', '链路已断开'))
    this.closeHook?.()
    if (this.role === 'offscreen' && !this.disposed) this.scheduleReconnect()
  }

  private receive(frame: LinkFrame, port: PortLike): void {
    if (frame.t === 'evt') {
      for (const listener of this.eventListeners) {
        try {
          listener(frame.type, frame.payload)
        } catch {}
      }
      return
    }
    if (frame.t === 'res') {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.settle(frame.id)
      if (frame.ok) pending.resolve(frame.data)
      else pending.reject(fromErrorData(frame.err))
      return
    }
    void this.serveRequest(frame, port)
  }

  private async serveRequest(frame: LinkRequestFrame, port: PortLike): Promise<void> {
    let response: LinkFrame
    try {
      const handler = this.handlers[frame.type]
      if (!handler) throw new LinkError('NO_HANDLER', `未知链路消息：${frame.type}`)
      const data = await handler(frame.payload, {
        peer: this.role === 'sw' ? 'offscreen' : 'sw',
      })
      response = { ch: LINK_CHANNEL, t: 'res', id: frame.id, ok: true, data }
    } catch (e) {
      response = { ch: LINK_CHANNEL, t: 'res', id: frame.id, ok: false, err: toErrorData(e) }
    }
    try {
      port.postMessage(response)
    } catch {}
  }

  private settle(id: number): void {
    const pending = this.pending.get(id)
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    this.pending.delete(id)
  }

  private rejectAll(error: LinkError): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const pending of entries) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  private handleHello(): { ok: true } {
    this.markReady()
    return { ok: true }
  }

  private markReady(): void {
    if (this.ready) return
    this.ready = true
    this.attempt = 0
    this.startHeartbeat()
    const waiters = [...this.readyWaiters]
    this.readyWaiters.clear()
    for (const waiter of waiters) waiter()
    this.openHook?.()
    for (const listener of this.openListeners) {
      try {
        listener()
      } catch {}
    }
  }

  private startHeartbeat(): void {
    if (!this.heartbeatMs || this.heartbeatTimer) return
    this.heartbeatMisses = 0
    this.heartbeatTimer = setInterval(() => void this.ping(), this.heartbeatMs)
    unref(this.heartbeatTimer)
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return
    clearInterval(this.heartbeatTimer as unknown as Parameters<typeof clearInterval>[0])
    this.heartbeatTimer = null
  }

  private async ping(): Promise<void> {
    try {
      await this.request('link:ping', undefined, { timeoutMs: Math.min(3000, this.heartbeatMs) })
      this.heartbeatMisses = 0
    } catch {
      this.heartbeatMisses += 1

      const port = this.port
      if (this.heartbeatMisses >= 2 && port) {
        try {
          port.disconnect()
        } catch {
          this.onPortGone(port)
        }
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.disposed) return
    const base = Math.min(this.backoffMaxMs, this.backoffInitialMs * 2 ** this.attempt)
    const delay = Math.round(base * (0.8 + Math.random() * 0.4))
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
    unref(this.reconnectTimer)
  }
}

export function connectLink(options: Omit<LinkOptions, 'role'> = {}): Link {
  const link = new Link({ ...options, role: 'offscreen' })
  link.open()
  return link
}

export function acceptLink(options: Omit<LinkOptions, 'role'> = {}): Link {
  const link = new Link({ ...options, role: 'sw' })
  link.accept()
  return link
}
