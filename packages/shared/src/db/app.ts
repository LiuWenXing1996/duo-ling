// duoling-app：扩展侧 KV（模型配置 / 密钥 DEK / 会话↔标签映射 / 更新检查记录 / 握手密钥）。
//
// 库实例住契约包：SW 与扩展页共用同一个库名（握手密钥由 SW 写、面板读），
// 实例与 schema 只该有一份 —— 否则同一库上挂两条连接，升级时互不知情。
import { createIdbOpener, type IdbOpener } from '../idb-core'

export const APP_DB_NAME = 'duoling-app'
export const APP_DB_VERSION = 1
export const APP_KV_STORE = 'kv'

let handle: IdbOpener | null = null

/** 惰性构造：模块求值期不做调用，否则打包器整块裁不掉本模块 */
export function getAppDb(): IdbOpener {
  return (handle ??= createIdbOpener({
    name: APP_DB_NAME,
    version: APP_DB_VERSION,
    upgrade: (db) => {
      if (!db.objectStoreNames.contains(APP_KV_STORE)) {
        db.createObjectStore(APP_KV_STORE, { keyPath: 'key' })
      }
    },
    label: '本地数据',
  }))
}
