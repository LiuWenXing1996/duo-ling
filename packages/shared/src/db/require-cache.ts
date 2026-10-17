// duoling-require-cache：@require 外部依赖源码快照（可清、与脚本数据分库）。
//
// 库实例住契约包：schema 只该有一份，读写由 SW 的业务文件按名字查。
import { createIdbOpener, type IdbOpener } from '../idb-core'

export const REQUIRE_CACHE_DB_NAME = 'duoling-require-cache'
export const REQUIRE_CACHE_DB_VERSION = 1
export const REQUIRE_CACHE_STORE = 'requires'

let handle: IdbOpener | null = null

/** 惰性构造：模块求值期不做调用，否则打包器整块裁不掉本模块 */
export function getRequireCacheDb(): IdbOpener {
  return (handle ??= createIdbOpener({
    name: REQUIRE_CACHE_DB_NAME,
    version: REQUIRE_CACHE_DB_VERSION,
    upgrade: (db) => {
      if (!db.objectStoreNames.contains(REQUIRE_CACHE_STORE)) {
        db.createObjectStore(REQUIRE_CACHE_STORE, { keyPath: 'url' })
      }
    },
    label: '依赖缓存',
  }))
}
