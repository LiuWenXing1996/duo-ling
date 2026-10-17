// duoling-state：项目元数据 + 分组（裸 IDB，SW / 扩展页 / offscreen 三方同库）。
//
// 库实例住契约包：三个上下文打开的是**同一个库名**（这才是共享存储的前提），
// 实例与 schema 只该有一份 —— 各上下文各自 createIdbOpener 会挂多条独立连接，
// 升级时互不知情（一方 onversionchange 放手、另一方还握着旧连接）。
import { createIdbOpener, type IdbOpener } from '../idb-core'

export const STATE_DB_NAME = 'duoling-state'
export const STATE_DB_VERSION = 2
export const STATE_PROJECTS_STORE = 'projects'
export const STATE_PROJECTS_KEY = 'uuid'
/** 分组对象库（脚本列表分组功能）；keyPath = id。与 projects 同库、同单写方约束 */
export const STATE_GROUPS_STORE = 'groups'

let handle: IdbOpener | null = null

/** 惰性构造：模块求值期不做调用，否则打包器整块裁不掉本模块 */
export function getStateDb(): IdbOpener {
  return (handle ??= createIdbOpener({
    name: STATE_DB_NAME,
    version: STATE_DB_VERSION,
    upgrade: (db) => {
      if (!db.objectStoreNames.contains(STATE_PROJECTS_STORE)) {
        db.createObjectStore(STATE_PROJECTS_STORE, { keyPath: STATE_PROJECTS_KEY })
      }
      // v2 升级：新增 groups 对象库（已存在的库走 onupgradeneeded 补建，无数据迁移）
      if (!db.objectStoreNames.contains(STATE_GROUPS_STORE)) {
        db.createObjectStore(STATE_GROUPS_STORE, { keyPath: 'id' })
      }
    },
    label: '脚本状态数据',
  }))
}
