// duoling-resource-cache：@resource 命名资源内容缓存（素材，与 @require 分库）。
//
// 库实例住契约包：schema 只该有一份，读写由 SW 的业务文件按名字查。
import { createIdbOpener, type IdbOpener } from '../idb-core'

export const RESOURCE_CACHE_DB_NAME = 'duoling-resource-cache'
export const RESOURCE_CACHE_DB_VERSION = 1
export const RESOURCE_CACHE_STORE = 'resources'

let handle: IdbOpener | null = null

/** 惰性构造：模块求值期不做调用，否则打包器整块裁不掉本模块 */
export function getResourceCacheDb(): IdbOpener {
  return (handle ??= createIdbOpener({
    name: RESOURCE_CACHE_DB_NAME,
    version: RESOURCE_CACHE_DB_VERSION,
    upgrade: (db) => {
      if (!db.objectStoreNames.contains(RESOURCE_CACHE_STORE)) {
        db.createObjectStore(RESOURCE_CACHE_STORE, { keyPath: 'url' })
      }
    },
    label: '资源缓存',
  }))
}
