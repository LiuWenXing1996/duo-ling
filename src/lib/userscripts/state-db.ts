// 用户脚本项目数据的底层存储：独立 IndexedDB 库（**与 lightning-fs 的 'duoling' 库分开**）。
//
// 为什么另起一个库：
// lfs 自带内存索引层，同库多实例会互相看不见写入（见 us-fs.ts 顶部的单实例约束），
// 所以 SW / 扩展页根本读不到 lfs 里的内容——这也是当前「项目数据只能放 chrome.storage」的根因。
// 裸 IndexedDB 是真正的共享存储：SW / offscreen / 扩展页打开同一个库名，看到的是同一份数据。
// 已实测：浏览器冷启动、offscreen 尚未创建时，SW 已能读到上一轮 offscreen 写进 IDB 的内容
// （docs/userscript-single-writer.md §5.1）。
//
// 单写方约定（本方案的核心，docs/userscript-single-writer.md）：
//   **写 API 只许 offscreen 调用**；SW 与扩展页只许读。
// 这不是技术限制（技术上谁都能写），是刻意的收敛——一次保存只有一个写方，
// 「写了状态但没 commit」「已保存但没 commit」这类偏差就没有产生的缝隙。
// 违反方式：在 offscreen 之外 import writeProject / removeProject 等。
import type { ScriptProject } from './types'

const DB_NAME = 'duoling-state'
const DB_VERSION = 1
const STORE = 'projects'
const KEY_PATH = 'uuid'

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
      req.onerror = () => reject(req.error ?? new Error('无法打开项目状态库'))
      req.onblocked = () => reject(new Error('项目状态库被其它上下文占用，无法升级'))
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
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'))
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb()
  const tx = db.transaction(STORE, mode)
  const result = await request(run(tx.objectStore(STORE)))
  return result
}

/** 读一个项目；不存在或形态不对（非 v:1）返回 undefined */
export async function readProject(uuid: string): Promise<ScriptProject | undefined> {
  const value = await withStore<ScriptProject | undefined>('readonly', (s) => s.get(uuid))
  return value?.v === 1 ? value : undefined
}

/** 读全部项目（v:1 形态；顺序由调用方决定） */
export async function readAllProjects(): Promise<ScriptProject[]> {
  const all = await withStore<ScriptProject[]>('readonly', (s) => s.getAll())
  return (all ?? []).filter((p) => p?.v === 1)
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
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  for (const uuid of uuids) store.delete(uuid)
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('批量删除失败'))
    tx.onabort = () => reject(tx.error ?? new Error('批量删除被中止'))
  })
}
