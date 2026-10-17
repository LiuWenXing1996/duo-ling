// duoling-runtime：观测数据（页存续行 + 一根活动轴）。
//
// 库实例住契约包：schema 是「这个库长什么样」的唯一真相，读写两侧（runtime-db / store）
// 只按名字查 —— 建表逻辑散在业务文件里，业务一改就得连带改版本，容易漂。
import { createIdbOpener, type IdbOpener } from '../idb-core'

export const RUNTIME_DB_NAME = 'duoling-runtime'
export const RUNTIME_DB_VERSION = 9

export const RUNTIME_TAB_SESSIONS_STORE = 'tab_sessions'
export const RUNTIME_TAB_EVENTS_STORE = 'tab_events'
/** 拆表时代的旧 store 名（v7 起重建成合表形状，见 upgrade） */
const LEGACY_STORES = ['errors', 'runlog', 'stats', 'runs', 'run_events']

/**
 * 合表形状首次落地的版本。
 * 早于它的库形状不兼容，要推倒重建；之后每加一条索引只做增量迁移 —— 重建等于把
 * 用户的活动历史整库抹掉，那是只有形状真变了才付得起的代价。
 */
const MERGED_SCHEMA_VERSION = 7

export const RUNTIME_TABS_BY_TAB = 'by_tabId'
export const RUNTIME_TABS_BY_SEEN = 'by_seen'
/**
 * 轴按页取行：`[tabSessionId, id]`（`id` 是表主键自增号，也就是落盘序）。
 * 为什么带上 id（增量续拉只能在索引键上做范围裁剪）见 docs/adr/0015-runtime-db-composite-indexes.md。
 */
export const RUNTIME_EV_BY_SESSION_SEQ = 'by_session_seq'
export const RUNTIME_EV_BY_KIND_RUN = 'by_kind_run'
export const RUNTIME_EV_BY_ERR = 'by_errId'
export const RUNTIME_EV_BY_KIND = 'by_kind'

/** v8 起退场的旧索引名：录制改按标签页后采样上不再有 host，该索引无从维护 */
const LEGACY_EV_BY_HOST = 'by_host'
/** v9 起退场的旧索引名：单键 by_tabSessionId 做不了增量范围裁剪，换成带 id 的复合索引 */
const LEGACY_EV_BY_SESSION = 'by_tabSessionId'

/** 合表形状的建表（v7 引入）。重建旧库与新建库都走它，免得索引清单在两处各写一份。 */
function createMergedStores(db: IDBDatabase): void {
  const tabs = db.createObjectStore(RUNTIME_TAB_SESSIONS_STORE, { keyPath: 'tabSessionId' })
  tabs.createIndex(RUNTIME_TABS_BY_TAB, 'tabId') // 实时判据：按 tabId 找还开着的那一行
  tabs.createIndex(RUNTIME_TABS_BY_SEEN, 'firstSeenAt') // 环形裁剪：按登记先后找最旧
  // 主键写进记录本身（keyPath）：读侧要拿 id 当行身份（面板的列表 key）。
  // 那种「主键只在表里、记录上读不到」的写法读回来的行没有 id —— 这张表不能用它。
  const events = db.createObjectStore(RUNTIME_TAB_EVENTS_STORE, { keyPath: 'id', autoIncrement: true })
  events.createIndex(RUNTIME_EV_BY_SESSION_SEQ, ['tabSessionId', 'id']) // 按页取整根轴 / 按页级联删除 / 按游标增量续拉
  events.createIndex(RUNTIME_EV_BY_KIND_RUN, ['kind', 'runId']) // 按运行精确取那一行 / 按运行拉动作（见 kindRunRange）
  events.createIndex(RUNTIME_EV_BY_ERR, 'errId') // 按错误 id 读（AI 的 error_read）
  events.createIndex(RUNTIME_EV_BY_KIND, 'kind') // 按 kind 取全量（运行条目 / 错误）与环形裁剪
}

let handle: IdbOpener | null = null

/** 惰性构造：模块求值期不做调用，否则打包器整块裁不掉本模块 */
export function getRuntimeDb(): IdbOpener {
  return (handle ??= createIdbOpener({
    name: RUNTIME_DB_NAME,
    version: RUNTIME_DB_VERSION,
    upgrade: (db, tx, oldVersion) => {
      // 拆表时代的旧形状与合表后的形状不兼容：删表重建，旧数据丢弃
      if (oldVersion < MERGED_SCHEMA_VERSION) {
        for (const name of [...LEGACY_STORES, RUNTIME_TAB_SESSIONS_STORE, RUNTIME_TAB_EVENTS_STORE]) {
          if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name)
        }
        createMergedStores(db)
        return
      }
      // v7 → v8：录制从「按站点」改为「按标签页」，采样不再带 host，by_host 索引随之退场。
      // 观测数据的形状本身没变，故**只摘索引、不动任何一行** —— 这一版没有任何理由清数据。
      const events = tx.objectStore(RUNTIME_TAB_EVENTS_STORE)
      if (oldVersion < 8 && events.indexNames.contains(LEGACY_EV_BY_HOST)) {
        events.deleteIndex(LEGACY_EV_BY_HOST)
      }
      // v8 → v9：面板按游标增量续拉，单键索引做不了「比某个 id 新」的裁剪，换成 [页, id]。
      // 同款处理：只摘旧的、补新的，一行数据都不碰。
      if (oldVersion < 9) {
        if (events.indexNames.contains(LEGACY_EV_BY_SESSION)) events.deleteIndex(LEGACY_EV_BY_SESSION)
        if (!events.indexNames.contains(RUNTIME_EV_BY_SESSION_SEQ)) {
          events.createIndex(RUNTIME_EV_BY_SESSION_SEQ, ['tabSessionId', 'id'])
        }
      }
    },
    label: '运行数据',
  }))
}
