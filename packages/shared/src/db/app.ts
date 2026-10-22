// duoling-app：扩展侧 KV（模型配置 / 密钥 DEK / 会话↔标签映射 / 更新检查记录 / 握手密钥）。
import Dexie, { type Table } from 'dexie'

export const APP_DB_NAME = 'duoling-app'
export const APP_DB_VERSION = 1
export const APP_KV_STORE = 'kv'

export interface AppKvRecord {
  key: string
  value: unknown
}

class AppDb extends Dexie {
  kv!: Table<AppKvRecord, string>

  constructor() {
    super(APP_DB_NAME)
    this.version(APP_DB_VERSION).stores({ [APP_KV_STORE]: 'key' })
  }
}

let handle: AppDb | null = null

/** 惰性构造：模块求值期不做调用，否则打包器整块裁不掉本模块 */
export function getAppDexie(): AppDb {
  return (handle ??= new AppDb())
}
