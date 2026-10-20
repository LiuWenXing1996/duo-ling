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
    if (value === undefined) tabStore.delete(this.#key)
    else tabStore.set(this.#key, value)
  }

  async getValue(key: string): Promise<unknown> {
    return (await openKv()).get(VALUES_STORE, [this.#scriptId, key])
  }

  async setValue(key: string, value: unknown): Promise<void> {
    const db = await openKv()
    const recordKey = [this.#scriptId, key]
    if (value == null) await db.delete(VALUES_STORE, recordKey)
    else await db.put(VALUES_STORE, value, recordKey)
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
