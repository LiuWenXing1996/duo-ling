// 用户脚本项目数据的底层存储：独立 IndexedDB 库（**与 lightning-fs 的 'duoling-fs' 库分开**）。
//
// 为什么另起一个库：
// lfs 自带内存索引层，同库多实例会互相看不见写入（见 us-fs.ts 顶部的单实例约束），
// 所以 SW / 扩展页根本读不到 lfs 里的内容——这也是当前「项目数据只能放 chrome.storage」的根因。
// 裸 IndexedDB 是真正的共享存储：SW / offscreen / 扩展页打开同一个库名，看到的是同一份数据。
// 已实测：浏览器冷启动、offscreen 尚未创建时，SW 已能读到上一轮 offscreen 写进 IDB 的内容。
//
// 单写方约定（本方案的核心）：
//   **写 API 只许 offscreen 调用**；SW 与扩展页只许读。
// 这不是技术限制（技术上谁都能写），是刻意的收敛——一次保存只有一个写方，
// 「写了状态但没 commit」「已保存但没 commit」这类偏差就没有产生的缝隙。
// 违反方式：在 offscreen 之外 import writeProject / removeProject 等。
import type { ScriptGroup, ScriptProject } from './types'

const DB_NAME = 'duoling-state'
const DB_VERSION = 2
export const STATE_DB_VERSION = DB_VERSION
const STORE = 'projects'
const KEY_PATH = 'uuid'
/** 分组对象库（脚本列表分组功能）；keyPath = id。与 projects 同库、同单写方约束 */
const GROUPS_STORE = 'groups'

let dbPromise: Promise<IDBDatabase> | undefined

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: KEY_PATH })
        }
        // v2 升级：新增 groups 对象库（已存在的库走 onupgradeneeded 补建，无数据迁移）
        if (!db.objectStoreNames.contains(GROUPS_STORE)) {
          db.createObjectStore(GROUPS_STORE, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => {
        const db = req.result
        // 别处要升级版本时先放手，否则对方一直 blocked；下次调用重新打开
        db.onversionchange = () => {
          db.close()
          dbPromise = undefined
        }
        resolve(db)
      }
      req.onerror = () => reject(req.error ?? new Error('无法打开脚本状态数据'))
      req.onblocked = () => reject(new Error('脚本状态数据被其它页面占用，无法升级'))
    }).catch((e: unknown) => {
      dbPromise = undefined // 失败不缓存，下次重试
      throw e
    })
  }
  return dbPromise
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('本地数据读取失败'))
  })
}

/** 连接已死（被外部删库 / 强制关闭）：transaction() 会同步抛 InvalidStateError "The database connection is closing" */
function isDeadConnection(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'InvalidStateError'
}

/**
 * 开事务执行（含死连接兜底）。
 * 外部删库（如 DevTools 面板强删）不触发 onversionchange，缓存的连接死后 dbPromise 永不重置，
 * 之后每次 transaction 都报 "connection is closing"——故这里捕获后重置缓存、重开一次。
 * 库被删本身无害：重新 open 时 onupgradeneeded 会把表建回来。
 */
async function runTx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction, store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const db = await openDb()
    try {
      const tx = db.transaction(store, mode)
      return await run(tx, tx.objectStore(store))
    } catch (e) {
      dbPromise = undefined
      if (attempt < 2 && isDeadConnection(e)) continue
      throw e
    }
  }
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return runTx(STORE, mode, (_tx, store) => request(run(store)))
}

/** 与 withStore 同构，但作用于 groups 对象库（脚本列表分组功能） */
async function withGroupsStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return runTx(GROUPS_STORE, mode, (_tx, store) => request(run(store)))
}

/** 读一个项目；不存在或形态不对（非 v:2）返回 undefined */
export async function readProject(uuid: string): Promise<ScriptProject | undefined> {
  const value = await withStore<ScriptProject | undefined>('readonly', (s) => s.get(uuid))
  return value?.v === 2 ? value : undefined
}

/** 读全部项目（v:2 形态；顺序由调用方决定） */
export async function readAllProjects(): Promise<ScriptProject[]> {
  const all = await withStore<ScriptProject[]>('readonly', (s) => s.getAll())
  return (all ?? []).filter((p) => p?.v === 2)
}

// —— 以下为写 API：只许 offscreen 调用（见文件头「单写方约定」）——

/** 写入 / 覆盖一个项目 */
export async function writeProject(project: ScriptProject): Promise<void> {
  await withStore('readwrite', (s) => s.put(project))
}

/** 删除一个项目 */
export async function removeProject(uuid: string): Promise<void> {
  await withStore('readwrite', (s) => s.delete(uuid))
}

/** 批量删除（同一事务，要么全成功要么全失败） */
export async function removeProjects(uuids: string[]): Promise<void> {
  if (!uuids.length) return
  await runTx(STORE, 'readwrite', (tx, store) => {
    for (const uuid of uuids) store.delete(uuid)
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('批量删除失败'))
      tx.onabort = () => reject(tx.error ?? new Error('批量删除被中止'))
    })
  })
}

// —— 分组对象库（脚本列表分组功能；与 projects 同单写方约束，只许 offscreen 调用） ——

/** 读全部分组（按 order 升序；顺序由 UI 决定展示） */
export async function readAllGroups(): Promise<ScriptGroup[]> {
  const all = await withGroupsStore<ScriptGroup[]>('readonly', (s) => s.getAll())
  return (all ?? []).sort((a, b) => a.order - b.order)
}

/** 读单个分组；不存在返回 undefined */
export async function readGroup(id: string): Promise<ScriptGroup | undefined> {
  return withGroupsStore<ScriptGroup | undefined>('readonly', (s) => s.get(id))
}

/** 写入 / 覆盖一个分组 */
export async function writeGroup(group: ScriptGroup): Promise<void> {
  await withGroupsStore('readwrite', (s) => s.put(group))
}

/** 删除一个分组（不影响项目：归未分组由调用方负责改写各项目的 group 字段） */
export async function removeGroup(id: string): Promise<void> {
  await withGroupsStore('readwrite', (s) => s.delete(id))
}
