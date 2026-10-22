import type { OffscreenPush } from './chat-ipc'

export const CHAT_CHUNK_CHANNEL = 'duoling:chat-chunk'

interface RuntimePort {
  sendMessage(message: unknown): Promise<unknown> | void
  onMessage?: {
    addListener(fn: (raw: unknown) => void): void
    removeListener(fn: (raw: unknown) => void): void
  }
}

function runtimePort(): RuntimePort | null {
  return (globalThis as { chrome?: { runtime?: RuntimePort } }).chrome?.runtime ?? null
}

let tx: BroadcastChannel | null | undefined
let rx: BroadcastChannel | null | undefined

function openChannel(slot: 'rx' | 'tx'): BroadcastChannel | null {
  const cached = slot === 'rx' ? rx : tx
  if (cached !== undefined) return cached
  let created: BroadcastChannel | null = null
  try {
    created =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHAT_CHUNK_CHANNEL)
  } catch {
    created = null
  }
  if (slot === 'rx') rx = created
  else tx = created
  return created
}

export function publishChatChunk(push: OffscreenPush): void {
  const channel = openChannel('tx')
  if (channel) {
    channel.postMessage(push)
    return
  }
  const port = runtimePort()
  if (!port) return
  try {
    void Promise.resolve(port.sendMessage(push)).catch(() => {})
  } catch {}
}

export function subscribeChatChunk(listener: (push: OffscreenPush) => void): () => void {
  const channel = openChannel('rx')
  if (channel) {
    const onMessage = (event: MessageEvent): void => {
      const push = event.data as OffscreenPush | undefined
      if (push?.kind === 'chat:chunk') listener(push)
    }
    channel.addEventListener('message', onMessage)
    return () => channel.removeEventListener('message', onMessage)
  }
  const listeners = runtimePort()?.onMessage
  if (!listeners) return () => {}
  const onMessage = (raw: unknown): void => {
    const push = raw as OffscreenPush | undefined
    if (push?.kind === 'chat:chunk') listener(push)
  }
  try {
    listeners.addListener(onMessage)
    return () => listeners.removeListener(onMessage)
  } catch {
    return () => {}
  }
}
