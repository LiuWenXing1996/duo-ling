// duoling-usdata：脚本自己写的数据（GM 值 + GM tab 值），SW 独占写。
//
import { createIdbOpener, type IdbOpener } from '../idb-core'

export const USDATA_DB_NAME = 'duoling-usdata'
export const USDATA_DB_VERSION = 1

/** GM 值：复合主键 [uuid, key] */
export const USDATA_GM_STORE = 'gm'
/** GM tab 值：复合主键 [uuid, tabId] */
export const USDATA_TAB_STORE = 'tab'

let handle: IdbOpener | null = null

/** 惰性构造：模块求值期不做调用，否则打包器整块裁不掉本模块 */
export function getUsdataDb(): IdbOpener {
  return (handle ??= createIdbOpener({
    name: USDATA_DB_NAME,
    version: USDATA_DB_VERSION,
    upgrade: (db) => {
      if (!db.objectStoreNames.contains(USDATA_GM_STORE)) {
        const gm = db.createObjectStore(USDATA_GM_STORE, { keyPath: ['uuid', 'key'] })
        gm.createIndex('by_uuid', 'uuid')
      }
      if (!db.objectStoreNames.contains(USDATA_TAB_STORE)) {
        const tab = db.createObjectStore(USDATA_TAB_STORE, { keyPath: ['uuid', 'tabId'] })
        tab.createIndex('by_uuid', 'uuid')
        tab.createIndex('by_tabId', 'tabId')
      }
    },
    label: '脚本数据',
  }))
}
