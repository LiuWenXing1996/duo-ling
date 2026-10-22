//
// 库实例住契约包：三个上下文打开的是**同一个库名**（这才是共享存储的前提），
import Dexie, { type Table } from 'dexie'
import type { ScriptGroup, ScriptProject } from '../script-project'

export const STATE_DB_NAME = 'duoling-state'
export const STATE_DB_VERSION = 2
export const STATE_PROJECTS_STORE = 'projects'
export const STATE_PROJECTS_KEY = 'uuid'
/** 分组对象库（脚本列表分组功能）；keyPath = id。与 projects 同库、同单写方约束 */
export const STATE_GROUPS_STORE = 'groups'

interface StateDbTables {
  projects: Table<ScriptProject, string>
  groups: Table<ScriptGroup, string>
}

class StateDb extends Dexie implements StateDbTables {
  projects!: Table<ScriptProject, string>
  groups!: Table<ScriptGroup, string>

  constructor() {
    super(STATE_DB_NAME)
    this.version(STATE_DB_VERSION).stores({
      [STATE_PROJECTS_STORE]: STATE_PROJECTS_KEY,
      [STATE_GROUPS_STORE]: 'id',
    })
  }
}

let handle: StateDb | null = null

/** 惰性构造：模块求值期不做调用，否则打包器整块裁不掉本模块 */
export function getStateDexie(): StateDb {
  return (handle ??= new StateDb())
}
