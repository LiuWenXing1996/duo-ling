import { mountServiceWorkerMessaging } from './messaging/service-worker-messenger'
import type { DLProtocolMap } from './dl-protocol'

const tabStore = new Map<string, unknown>()

const keyOf = (scriptId: string | undefined, tabId: number | undefined): string | null =>
  scriptId && tabId != null ? `${scriptId}:${tabId}` : null

let mounted = false

// 必须在 defineBackground 的同步段调用：SW 唤醒投递只认同步注册表。
export function mountTabStore(): void {
  if (mounted) return
  mounted = true
  const messaging = mountServiceWorkerMessaging<DLProtocolMap>()
  messaging.onMessage('tab.get', (message) => {
    const key = keyOf(message.scriptId, message.sender.tab?.id)
    return key ? tabStore.get(key) : undefined
  })
  messaging.onMessage('tab.save', (message) => {
    const key = keyOf(message.scriptId, message.sender.tab?.id)
    if (key) tabStore.set(key, message.data?.value)
  })
  chrome.tabs.onRemoved.addListener((closedTabId) => {
    for (const key of [...tabStore.keys()]) {
      if (key.endsWith(`:${closedTabId}`)) tabStore.delete(key)
    }
  })
}
