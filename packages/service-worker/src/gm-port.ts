import { BRIDGE_MSG_TAG_VALUE, type ApiEvent, type ApiEventFrame, type Json } from '@duoling/shared'
import { onGmValueChange } from './gm-values'

export function parseGmPortName(name: string): { uuid: string; connId: string } | null {
  const m = /^duoling:gm:([^:]+):(.+)$/.exec(name)
  return m ? { uuid: m[1]!, connId: m[2]! } : null
}

export function parseMenuitemId(id: string | number): { uuid: string; menuId: string } | null {
  if (typeof id !== 'string') return null
  const m = /^us:([^:]+):(.+)$/.exec(id)
  return m ? { uuid: m[1]!, menuId: m[2]! } : null
}

export interface GmPortMeta {
  uuid: string
  connId: string
  tabId: number | null
}

export class GmPortRegistry {
  private ports = new Map<chrome.runtime.Port, GmPortMeta>()
  private watches = new Map<chrome.runtime.Port, Set<string>>()
  private notifyMap = new Map<string, string>()
  private valueWatchers = new Set<chrome.runtime.Port>()
  private audioWatchers = new Set<chrome.runtime.Port>()

  addPort(port: chrome.runtime.Port, meta: GmPortMeta): void {
    for (const [old, m] of this.ports) {
      if (m.uuid === meta.uuid && m.connId === meta.connId && old !== port) {
        try {
          old.disconnect()
        } catch {}
        this.removePort(old)
      }
    }
    this.ports.set(port, meta)
    this.watches.set(port, new Set())
  }

  removePort(port: chrome.runtime.Port): void {
    const meta = this.ports.get(port)
    this.ports.delete(port)
    this.watches.delete(port)
    this.valueWatchers.delete(port)
    this.audioWatchers.delete(port)
    if (meta) forgetNoPortWarn(meta.uuid, meta.connId)
  }

  /** 该 Port 的连接身份（判 `store.change` 的 remote 用：与发起写者同 connId = 本实例自己写的） */
  connIdOf(port: chrome.runtime.Port): string | undefined {
    return this.ports.get(port)?.connId
  }

  get meta(): Iterable<[chrome.runtime.Port, GmPortMeta]> {
    return this.ports.entries()
  }

  portsByConnId(uuid: string, connId: string): chrome.runtime.Port[] {
    const out: chrome.runtime.Port[] = []
    for (const [port, m] of this.ports) {
      if (m.uuid === uuid && m.connId === connId) out.push(port)
    }
    return out
  }

  attachWatch(uuid: string, connId: string, key: string): boolean {
    const targets = this.portsByConnId(uuid, connId)
    if (!targets.length) return false
    for (const port of targets) this.watches.get(port)!.add(key)
    return true
  }

  detachWatch(uuid: string, connId: string, key: string): void {
    for (const port of this.portsByConnId(uuid, connId)) this.watches.get(port)?.delete(key)
  }

  watchersForKey(uuid: string, key: string): chrome.runtime.Port[] {
    const out: chrome.runtime.Port[] = []
    for (const [port, keys] of this.watches) {
      if (this.ports.get(port)!.uuid === uuid && keys.has(key)) out.push(port)
    }
    return out
  }

  portsForTab(uuid: string, tabId: number): chrome.runtime.Port[] {
    const out: chrome.runtime.Port[] = []
    for (const [port, m] of this.ports) {
      if (m.uuid === uuid && m.tabId === tabId) out.push(port)
    }
    return out
  }

  portsByUuid(uuid: string): chrome.runtime.Port[] {
    const out: chrome.runtime.Port[] = []
    for (const [port, m] of this.ports) {
      if (m.uuid === uuid) out.push(port)
    }
    return out
  }

  trackNotification(notificationId: string, uuid: string): void {
    this.notifyMap.set(notificationId, uuid)
  }

  ownerOfNotification(notificationId: string): string | null {
    return this.notifyMap.get(notificationId) ?? null
  }

  attachValueWatch(uuid: string, connId: string): boolean {
    const targets = this.portsByConnId(uuid, connId)
    if (!targets.length) return false
    for (const port of targets) this.valueWatchers.add(port)
    return true
  }

  portsForValueChange(uuid: string): chrome.runtime.Port[] {
    const out: chrome.runtime.Port[] = []
    for (const [port, m] of this.ports) {
      if (m.uuid === uuid && this.valueWatchers.has(port)) out.push(port)
    }
    return out
  }

  attachAudioWatch(uuid: string, connId: string): boolean {
    const targets = this.portsByConnId(uuid, connId)
    if (!targets.length) return false
    for (const port of targets) this.audioWatchers.add(port)
    return true
  }

  detachAudioWatch(uuid: string, connId: string): void {
    for (const port of this.portsByConnId(uuid, connId)) this.audioWatchers.delete(port)
  }

  portsForAudioWatch(tabId: number): chrome.runtime.Port[] {
    const out: chrome.runtime.Port[] = []
    for (const [port, m] of this.ports) {
      if (m.tabId === tabId && this.audioWatchers.has(port)) out.push(port)
    }
    return out
  }
}

export function pushEvent(registry: GmPortRegistry, port: chrome.runtime.Port, ev: ApiEvent): void {
  const frame: ApiEventFrame = { __gm: BRIDGE_MSG_TAG_VALUE, kind: 'api', ev }
  try {
    port.postMessage(frame)
  } catch {
    registry.removePort(port)
  }
}

let registrySingleton: GmPortRegistry | null = null

export function getGmPortRegistry(): GmPortRegistry {
  if (!registrySingleton) registrySingleton = new GmPortRegistry()
  return registrySingleton
}

export function registerScriptMenu(uuid: string, menuId: string, title: string): Promise<void> {
  const id = `us:${uuid}:${menuId}`
  return new Promise((resolve, reject) => {
    chrome.contextMenus.remove(id, () => {
      void chrome.runtime.lastError
      chrome.contextMenus.create({ id, title, contexts: ['page', 'frame'] }, () => {
        const err = chrome.runtime.lastError
        if (!err) {
          console.log('[duoling:gm] 菜单已登记：', id)
          return resolve()
        }
        if (/duplicate/i.test(err.message ?? '')) {
          console.log('[duoling:gm] 菜单已在位（并发竞态，幂等）：', id)
          return resolve()
        }
        console.warn('[duoling:gm] 菜单登记失败：', id, err.message)
        reject(new Error(`菜单登记失败：${err.message}`))
      })
    })
  })
}

export function unregisterScriptMenu(uuid: string, menuId: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.contextMenus.remove(`us:${uuid}:${menuId}`, () => {
      void chrome.runtime.lastError
      resolve()
    })
  })
}

export function attachScriptWatch(uuid: string, connId: string, key: string): boolean {
  return getGmPortRegistry().attachWatch(uuid, connId, key)
}

export function detachScriptWatch(uuid: string, connId: string, key: string): void {
  getGmPortRegistry().detachWatch(uuid, connId, key)
}

export function attachValueWatch(uuid: string, connId: string): boolean {
  return getGmPortRegistry().attachValueWatch(uuid, connId)
}

export function attachAudioWatch(uuid: string, connId: string): boolean {
  return getGmPortRegistry().attachAudioWatch(uuid, connId)
}

export function detachAudioWatch(uuid: string, connId: string): void {
  getGmPortRegistry().detachAudioWatch(uuid, connId)
}

const noPortWarned = new Set<string>()

function warnNoPort(kind: string, uuid: string, connId?: string): void {
  const key = connId ? `${uuid}:${connId}` : uuid
  if (noPortWarned.has(key)) return
  noPortWarned.add(key)
  console.warn(
    `[duoling:gm] ${kind} 帧无处可推：该脚本没有下行通道（它从未读值 / 注册菜单 / 订阅音频 / 用带回调的通知）。` +
      `请求本身会照常完成，但脚本的回调收不到。uuid=${uuid}`,
  )
}

function forgetNoPortWarn(uuid: string, connId: string): void {
  noPortWarned.delete(`${uuid}:${connId}`)
}

export function pushFetchProgress(
  uuid: string,
  connId: string,
  frame: { requestId: string; loaded: number; total: number | null },
): void {
  const registry = getGmPortRegistry()
  const ports = registry.portsByConnId(uuid, connId)
  if (!ports.length) warnNoPort('xhr.progress', uuid, connId)
  for (const port of ports) {
    pushEvent(registry, port, { t: 'xhr.progress', ...frame })
  }
}

export function pushCommandTo(uuid: string, tabId: number, ev: ApiEvent): number {
  const registry = getGmPortRegistry()
  const ports = registry.portsForTab(uuid, tabId)
  for (const port of ports) pushEvent(registry, port, ev)
  return ports.length
}

export function pushDownloadChange(
  uuid: string,
  connId: string,
  frame: {
    requestId: string
    state: 'progress' | 'complete' | 'interrupted'
    loaded: number
    total: number | null
    error?: string
  },
): void {
  const registry = getGmPortRegistry()
  const ports = registry.portsByConnId(uuid, connId)
  if (!ports.length) warnNoPort('download.change', uuid, connId)
  for (const port of ports) {
    pushEvent(registry, port, { t: 'download.change', ...frame })
  }
}

export function mintNotification(uuid: string): string {
  const id = `us-${crypto.randomUUID()}`
  getGmPortRegistry().trackNotification(id, uuid)
  return id
}

export function initGmPort(): void {
  const onScriptConnect = chrome.runtime.onUserScriptConnect
  if (typeof onScriptConnect?.addListener !== 'function') {
    console.warn(
      '[duoling:gm] runtime.onUserScriptConnect 不可用，GM Port 未挂载（下行事件全失效）',
    )
    return
  }
  const registry = getGmPortRegistry()

  onScriptConnect.addListener((port) => {
    const parsed = parseGmPortName(port.name)
    if (!parsed) return
    const scriptId = (port.sender as { userScript?: { scriptId?: string } } | undefined)?.userScript
      ?.scriptId
    if (scriptId && scriptId !== parsed.uuid) {
      port.disconnect()
      return
    }
    const meta: GmPortMeta = {
      uuid: parsed.uuid,
      connId: parsed.connId,
      tabId: port.sender?.tab?.id ?? null,
    }
    registry.addPort(port, meta)
    pushEvent(registry, port, { t: 'port.ready' })
    port.onDisconnect.addListener(() => registry.removePort(port))
  })

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const parsed = parseMenuitemId(info.menuItemId)
    if (!parsed || tab?.id == null) return
    const ports = registry.portsForTab(parsed.uuid, tab.id)
    for (const port of ports) pushEvent(registry, port, { t: 'menu.click', id: parsed.menuId })
  })

  onGmValueChange(({ uuid, key, deleted, value, oldValue, writerConnId }) => {
    const frameValue = (deleted ? null : value) as Json
    const frameOldValue = (oldValue === undefined ? null : oldValue) as Json
    const targets = new Set([
      ...registry.watchersForKey(uuid, key),
      ...registry.portsForValueChange(uuid),
    ])
    for (const port of targets) {
      pushEvent(registry, port, {
        t: 'store.change',
        key,
        value: frameValue,
        oldValue: frameOldValue,
        remote: !writerConnId || registry.connIdOf(port) !== writerConnId,
      })
    }
  })

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.mutedInfo === undefined && changeInfo.audible === undefined) return
    const targets = registry.portsForAudioWatch(tabId)
    if (!targets.length) return
    const info = changeInfo.mutedInfo
    for (const port of targets) {
      pushEvent(registry, port, {
        t: 'audio.change',
        ...(info ? { muted: info.muted ? (info.reason ?? 'user') : false } : {}),
        ...(changeInfo.audible !== undefined ? { audible: changeInfo.audible } : {}),
      })
    }
  })

  chrome.notifications.onClicked.addListener((notificationId) => {
    const uuid = registry.ownerOfNotification(notificationId)
    if (!uuid) return
    const ports = registry.portsByUuid(uuid)
    if (!ports.length) warnNoPort('notify.click', uuid)
    for (const port of ports) {
      pushEvent(registry, port, { t: 'notify.click', id: notificationId })
    }
  })
}
