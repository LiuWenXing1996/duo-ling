import { openDB, type IDBPDatabase } from 'idb'
import { ServiceWorkerMessenger } from '../messaging/service-worker-messenger'
import { NOTIFICATION_CLICK_TYPE, VALUE_CHANGE_TYPE } from '../messaging/protocol'
import { registerService, type ServiceContext } from '../proxy-service'
import { SW_SERVICE_KEY } from './keys'

const tabStore = new Map<string, unknown>()

const VALUES_STORE = 'script_values'
const DB_VERSION = 1

let database = ''
let opening: Promise<IDBPDatabase> | undefined

const openKv = (): Promise<IDBPDatabase> =>
  (opening ??= openDB(database, DB_VERSION, {
    upgrade: (db) => {
      db.createObjectStore(VALUES_STORE)
    },
  }).catch((e: unknown) => {
    opening = undefined
    throw e
  }))

export class SwService {
  readonly #key: string
  readonly #scriptId: string
  readonly #tabId: number

  constructor(context: ServiceContext) {
    this.#key = `${context.scriptId}:${context.tabId}`
    this.#scriptId = context.scriptId
    this.#tabId = context.tabId
  }

  async getTab(): Promise<unknown> {
    return tabStore.get(this.#key)
  }

  async saveTab(value?: unknown): Promise<void> {
    if (value == null) tabStore.delete(this.#key)
    else tabStore.set(this.#key, value)
  }

  getTabs(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    const prefix = `${this.#scriptId}:`
    for (const [key, value] of tabStore) {
      if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value
    }
    return out
  }

  async openInTab(url: string, active: boolean): Promise<number> {
    const tab = await chrome.tabs.create({ url, active })
    if (tab?.id == null) throw new Error('openInTab：chrome.tabs.create 没有返回标签页 id')
    return tab.id
  }

  async closeTab(tabId?: number): Promise<void> {
    const target = tabId ?? this.#tabId
    const closing = await chrome.tabs.get(target).catch(() => undefined)
    if (closing?.windowId != null) {
      const siblings = await chrome.tabs.query({ windowId: closing.windowId })
      if (siblings.length <= 1) throw new Error('closeTab：不允许关闭窗口的最后一个标签页')
    }
    await chrome.tabs.remove(target)
  }

  async focusTab(tabId?: number): Promise<void> {
    const target = tabId ?? this.#tabId
    const tab = await chrome.tabs.update(target, { active: true })
    if (tab?.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    }
  }

  async setClipboard(text: string | null, html: string | null): Promise<void> {
    if (!clipboardWrite) throw new Error('setClipboard：宿主没有注入剪贴板写入能力')
    if (!text && !html) throw new Error('setClipboard：text 与 html 至少给一个')
    await clipboardWrite({ text, html })
  }

  async notify(details: NotificationRequest): Promise<string> {
    const icon = details.icon || notificationHost?.icon
    if (!icon) throw new Error('notify：没有可用的通知图标（宿主没注入 notification.icon）')
    const title = details.title || notificationHost?.appName
    if (!title) throw new Error('notify：没有可用的通知标题（宿主没注入 notification.appName）')
    const id = `${NOTIFICATION_ID_PREFIX}${this.#scriptId}:${++notificationSeq}`
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: icon,
      title,
      message: details.text,
    })
    return id
  }

  #recordKey(key: string): [string, string] {
    return [this.#scriptId, key]
  }

  #range(): IDBKeyRange {
    return IDBKeyRange.bound([this.#scriptId], [this.#scriptId, []])
  }

  async getValue(key: string): Promise<unknown> {
    return (await openKv()).get(VALUES_STORE, this.#recordKey(key))
  }

  async setValue(key: string, value: unknown): Promise<void> {
    const db = await openKv()
    const oldValue = await db.get(VALUES_STORE, this.#recordKey(key))
    if (value == null) await db.delete(VALUES_STORE, this.#recordKey(key))
    else await db.put(VALUES_STORE, value, this.#recordKey(key))
    this.#emitChange(key, oldValue, value ?? undefined)
  }

  async deleteValue(key: string): Promise<void> {
    const db = await openKv()
    const oldValue = await db.get(VALUES_STORE, this.#recordKey(key))
    await db.delete(VALUES_STORE, this.#recordKey(key))
    this.#emitChange(key, oldValue, undefined)
  }

  async listValues(): Promise<string[]> {
    const keys = await (await openKv()).getAllKeys(VALUES_STORE, this.#range())
    return keys.map((key) => String((key as [string, string])[1]))
  }

  async getValues(keys?: string[]): Promise<Record<string, unknown>> {
    const db = await openKv()
    if (Array.isArray(keys)) {
      const tx = db.transaction(VALUES_STORE)
      const values = await Promise.all(keys.map((key) => tx.store.get(this.#recordKey(key))))
      await tx.done
      const entries: [string, unknown][] = []
      for (const [i, key] of keys.entries()) {
        const value = values[i]
        if (value !== undefined) entries.push([key, value])
      }
      return Object.fromEntries(entries)
    }
    const tx = db.transaction(VALUES_STORE)
    const entries: [string, unknown][] = []
    let cursor = await tx.store.openCursor(this.#range())
    while (cursor) {
      entries.push([String((cursor.key as [string, string])[1]), cursor.value])
      cursor = await cursor.continue()
    }
    await tx.done
    return Object.fromEntries(entries)
  }

  async setValues(values: Record<string, unknown>): Promise<void> {
    const db = await openKv()
    const olds = await Promise.all(
      Object.keys(values).map((key) => db.get(VALUES_STORE, this.#recordKey(key))),
    )
    const tx = db.transaction(VALUES_STORE, 'readwrite')
    const requests = Object.entries(values).map(([key, value]) =>
      value == null
        ? tx.store.delete(this.#recordKey(key))
        : tx.store.put(value, this.#recordKey(key)),
    )
    await Promise.all(requests)
    await tx.done
    for (const [i, key] of Object.keys(values).entries()) {
      this.#emitChange(key, olds[i], values[key] ?? undefined)
    }
  }

  async deleteValues(keys: string[]): Promise<void> {
    const db = await openKv()
    const olds = await Promise.all(keys.map((key) => db.get(VALUES_STORE, this.#recordKey(key))))
    const tx = db.transaction(VALUES_STORE, 'readwrite')
    await Promise.all(keys.map((key) => tx.store.delete(this.#recordKey(key))))
    await tx.done
    for (const [i, key] of keys.entries()) this.#emitChange(key, olds[i], undefined)
  }

  #emitChange(key: string, oldValue: unknown, newValue: unknown): void {
    const messenger = ServiceWorkerMessenger.instance
    for (const tabId of messenger.tabIdsOf(this.#scriptId)) {
      messenger.emit(tabId, this.#scriptId, VALUE_CHANGE_TYPE, {
        key,
        oldValue,
        newValue,
        remote: tabId !== this.#tabId,
      })
    }
  }
}

export type ClipboardWrite = (payload: {
  text: string | null
  html: string | null
}) => Promise<void>

export interface NotificationRequest {
  text: string
  title?: string
  icon?: string
}

export interface NotificationHost {
  icon?: string
  appName?: string
}

const NOTIFICATION_ID_PREFIX = 'dl:notify:'
let notificationSeq = 0

let mounted = false
let clipboardWrite: ClipboardWrite | undefined
let notificationHost: NotificationHost | undefined

export function mountSwService(
  databaseName: string,
  options: { clipboard?: ClipboardWrite; notification?: NotificationHost } = {},
): void {
  if (mounted) {
    if (databaseName !== database) {
      throw new Error(`脚本存储库名只能定一次：已是 ${database}，又传 ${databaseName}`)
    }
    return
  }
  mounted = true
  database = databaseName
  clipboardWrite = options.clipboard
  notificationHost = options.notification
  registerService(SW_SERVICE_KEY, (context) => new SwService(context))
  chrome.tabs.onRemoved.addListener(clearTab)
  watchNotificationClicks()
}

// 通知 id 里带 scriptId，点击唤醒的 SW 靠解析拿归属 —— 内存表在回收后是空的
function scriptIdOfNotification(id: string): string | null {
  if (!id.startsWith(NOTIFICATION_ID_PREFIX)) return null
  const rest = id.slice(NOTIFICATION_ID_PREFIX.length)
  const cut = rest.lastIndexOf(':')
  return cut > 0 ? rest.slice(0, cut) : null
}

function watchNotificationClicks(): void {
  const api = chrome.notifications
  if (typeof api?.onClicked?.addListener !== 'function') return
  api.onClicked.addListener((notificationId) => {
    const scriptId = scriptIdOfNotification(notificationId)
    if (!scriptId) return
    void api.clear(notificationId).catch(() => {})
    const messenger = ServiceWorkerMessenger.instance
    for (const tabId of messenger.tabIdsOf(scriptId)) {
      messenger.emit(tabId, scriptId, NOTIFICATION_CLICK_TYPE, { id: notificationId })
    }
  })
}

function clearTab(tabId: number): void {
  for (const key of [...tabStore.keys()]) {
    if (key.endsWith(`:${tabId}`)) tabStore.delete(key)
  }
}
