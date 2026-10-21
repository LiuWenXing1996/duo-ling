import { openDB, type IDBPDatabase } from 'idb'
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

  constructor(context: ServiceContext) {
    this.#key = `${context.scriptId}:${context.tabId}`
    this.#scriptId = context.scriptId
  }

  async getTab(): Promise<unknown> {
    return tabStore.get(this.#key)
  }

  async saveTab(value?: unknown): Promise<void> {
    if (value == null) tabStore.delete(this.#key)
    else tabStore.set(this.#key, value)
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
    if (value == null) await db.delete(VALUES_STORE, this.#recordKey(key))
    else await db.put(VALUES_STORE, value, this.#recordKey(key))
  }

  async deleteValue(key: string): Promise<void> {
    await (await openKv()).delete(VALUES_STORE, this.#recordKey(key))
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
    const tx = db.transaction(VALUES_STORE, 'readwrite')
    const requests = Object.entries(values).map(([key, value]) =>
      value == null
        ? tx.store.delete(this.#recordKey(key))
        : tx.store.put(value, this.#recordKey(key)),
    )
    await Promise.all(requests)
    await tx.done
  }

  async deleteValues(keys: string[]): Promise<void> {
    const db = await openKv()
    const tx = db.transaction(VALUES_STORE, 'readwrite')
    await Promise.all(keys.map((key) => tx.store.delete(this.#recordKey(key))))
    await tx.done
  }
}

let mounted = false

export function mountSwService(databaseName: string): void {
  if (mounted) {
    if (databaseName !== database) {
      throw new Error(`脚本存储库名只能定一次：已是 ${database}，又传 ${databaseName}`)
    }
    return
  }
  mounted = true
  database = databaseName
  registerService(SW_SERVICE_KEY, (context) => new SwService(context))
  chrome.tabs.onRemoved.addListener(clearTab)
}

function clearTab(tabId: number): void {
  for (const key of [...tabStore.keys()]) {
    if (key.endsWith(`:${tabId}`)) tabStore.delete(key)
  }
}
