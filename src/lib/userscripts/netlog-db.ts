// 网络录制观测数据的底层存储：独立 IndexedDB 库 duoling-netlog（SW 独占写）。
//
// 为什么单独一库：这里放的是**页面接口流量的采样**——隐私敏感、按站点授权、
// 生命周期随「关录制 / 清记录」走；与脚本自存数据（duoling-usdata）、
// 脚本观测数据（duoling-runtime）的信任级与演进节奏都不同，混库会让
// 「清某 host 的录制」变成跨表手术。
//
// 单写方：写 API 只许 SW 调用（写入口是 dl-bridge 的 __dlNetCapture 分支）；
// 本模块不感知 chrome API，node 单测用 fake-indexeddb/auto 直测。
//
// 环形：每 host 保留最近 NET_HOST_RING_LIMIT 条，超出删最旧——隐私（少留）与
// 体积（不涨）双控，且「该站点已观测接口」的摘要天然反映最近一次访问。

import {
  NET_HOST_RING_LIMIT,
  type NetCaptureRecord,
} from './net-record-protocol'

const DB_NAME = 'duoling-netlog'
const DB_VERSION = 1

const CAPTURE_STORE = 'captures'

let dbPromise: Promise<IDBDatabase> | undefined

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(CAPTURE_STORE)) {
          const store = db.createObjectStore(CAPTURE_STORE, { keyPath: 'id', autoIncrement: true })
          store.createIndex('by_host', 'host')
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
      req.onerror = () => reject(req.error ?? new Error('无法打开录制数据'))
      req.onblocked = () => reject(new Error('录制数据被其它页面占用，无法升级'))
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

// 连接已死（被外部删库 / 强制关闭）：transaction() 会同步抛 InvalidStateError
function isDeadConnection(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'InvalidStateError'
}

async function runTx<T>(
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction, store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const db = await openDb()
    try {
      const tx = db.transaction(CAPTURE_STORE, mode)
      return await run(tx, tx.objectStore(CAPTURE_STORE))
    } catch (e) {
      dbPromise = undefined
      if (attempt < 2 && isDeadConnection(e)) continue
      throw e
    }
  }
}

/** 事务收尾：等在 oncomplete 上（写路径必须等落盘，不能只在 request success 就返回） */
function txDone(tx: IDBTransaction, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error(label))
    tx.onabort = () => reject(tx.error ?? new Error(label + '（事务被中止）'))
  })
}

/** 按 host 游标遍历骨架（环形裁剪 / 清空共用） */
function eachHostRecord(
  store: IDBObjectStore,
  host: string,
  onRecord: (cursor: IDBCursorWithValue) => boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cur = store.index('by_host').openCursor(IDBKeyRange.only(host))
    cur.onsuccess = () => {
      const c = cur.result
      if (!c) {
        resolve()
        return
      }
      if (onRecord(c)) c.continue()
      else resolve()
    }
    cur.onerror = () => reject(cur.error ?? new Error('读取录制数据失败'))
  })
}

/**
 * 追加一条采集记录，并按 host 做环形裁剪（超 NET_HOST_RING_LIMIT 删最旧）。
 * 主键自增（调用方传入的 id 一律忽略）；环形与插入在同一事务里完成，
 * 避免并发写把上限冲破。
 */
export async function appendCapture(rec: NetCaptureRecord): Promise<void> {
  await runTx('readwrite', async (tx, store) => {
    const { id: _ignored, ...payload } = rec
    void _ignored
    const existing = await request<number>(store.index('by_host').count(rec.host))
    store.add(payload)
    const excess = existing + 1 - NET_HOST_RING_LIMIT
    if (excess > 0) {
      let removed = 0
      await eachHostRecord(store, rec.host, (cursor) => {
        if (removed >= excess) return false
        cursor.delete()
        removed++
        return true
      })
    }
    await txDone(tx, '保存录制数据失败')
  })
}

/** 某 host 的采集记录（按采集先后升序；索引内等键按主键序＝插入序） */
export async function listCapturesByHost(host: string): Promise<NetCaptureRecord[]> {
  return runTx('readonly', async (_tx, store) => {
    const recs = await request<NetCaptureRecord[]>(store.index('by_host').getAll(host))
    return recs ?? []
  })
}

/** 某 host 当前记录数（上限断言 / UI 展示用） */
export async function countCapturesByHost(host: string): Promise<number> {
  return runTx('readonly', async (_tx, store) => {
    return request<number>(store.index('by_host').count(host))
  })
}

/** 清空某 host 的全部采集记录（「关录制 = 清该 host 记录」的落点） */
export async function clearCapturesByHost(host: string): Promise<void> {
  await runTx('readwrite', async (tx, store) => {
    await eachHostRecord(store, host, (cursor) => {
      cursor.delete()
      return true
    })
    await txDone(tx, '清空录制数据失败')
  })
}

/** 已录过的全部 host（去重；索引键序，供摘要 / 管理界面枚举） */
export async function listCapturedHosts(): Promise<string[]> {
  return runTx('readonly', async (_tx, store) => {
    return new Promise<string[]>((resolve, reject) => {
      const out: string[] = []
      const cur = store.index('by_host').openKeyCursor()
      cur.onsuccess = () => {
        const c = cur.result
        if (!c) {
          resolve(out)
          return
        }
        const key = String(c.key)
        if (out[out.length - 1] !== key) out.push(key)
        c.continue()
      }
      cur.onerror = () => reject(cur.error ?? new Error('读取已录站点失败'))
    })
  })
}

// —— 测试辅助（仅单测使用；清空全部记录保证用例隔离）——

export async function clearAllForTests(): Promise<void> {
  await runTx('readwrite', async (tx, store) => {
    store.clear()
    await txDone(tx, '清空录制数据失败')
  })
}
