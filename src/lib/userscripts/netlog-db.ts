// 网络录制观测数据的底层存储：独立 IndexedDB 库 duoling-netlog（SW 独占写）。
//
// 为什么单独一库：这里放的是**页面接口流量的采样**——隐私敏感、按站点授权、
// 生命周期随「关录制 / 清记录」走；与脚本自存数据（duoling-usdata）、
// 脚本观测数据（duoling-runtime）的信任级与演进节奏都不同，混库会让
// 「清某 host 的录制」变成跨表手术。
//
// 两张表：
//   · captures —— 采集记录本身（按 host 环形裁剪，见下）；
//   · sessions —— 录制会话的**归档**（元信息：哪个页面、什么时候录的）。
// 进行中的会话不在库里（它在 net-capture-gate 的门禁中），结束后才归档进来；
// 记录与归档都按 host 索引，因为「看某个站点录到了什么」是唯一的查询入口。
//
// 单写方：写 API 只许 SW 调用（写入口是 dl-bridge 的 __dlNetCapture 分支与会话归档）；
// 本模块不感知 chrome API，node 单测用 fake-indexeddb/auto 直测。
//
// 环形：每 host 保留最近 NET_HOST_RING_LIMIT 条，超出删最旧——隐私（少留）与
// 体积（不涨）双控，且「该站点已观测接口」的摘要天然反映最近一次访问。

import {
  NET_HOST_RING_LIMIT,
  type NetCaptureRecord,
  type NetRecordSession,
} from './net-record-protocol'
import { createIdbOpener, idbRequest as request, idbRunTx } from '../idb-core'

const DB_NAME = 'duoling-netlog'
// 2 = 新增 sessions 表（1 只有 captures）。旧库升级时只需补建新表，captures 原地不动。
const DB_VERSION = 2

const CAPTURE_STORE = 'captures'
const SESSION_STORE = 'sessions'

const opener = createIdbOpener({
  name: DB_NAME,
  version: DB_VERSION,
  upgrade: (db) => {
    if (!db.objectStoreNames.contains(CAPTURE_STORE)) {
      const store = db.createObjectStore(CAPTURE_STORE, { keyPath: 'id', autoIncrement: true })
      store.createIndex('by_host', 'host')
    }
    if (!db.objectStoreNames.contains(SESSION_STORE)) {
      // 会话 id 自带（不是自增）：归档与记录归属用的是同一个 id
      db.createObjectStore(SESSION_STORE, { keyPath: 'id' }).createIndex('by_host', 'host')
    }
  },
  label: '录制数据',
})

/** 捕获记录表的事务（写路径必须等落盘，故调用方自取 store 后 waitTx） */
function captureTx<T>(
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction, store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  return idbRunTx(opener, CAPTURE_STORE, mode, (tx) => run(tx, tx.objectStore(CAPTURE_STORE)))
}

/** 会话归档表的事务 */
function sessionTx<T>(
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction, store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  return idbRunTx(opener, SESSION_STORE, mode, (tx) => run(tx, tx.objectStore(SESSION_STORE)))
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
  await captureTx('readwrite', async (tx, store) => {
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
  return captureTx('readonly', async (_tx, store) => {
    const recs = await request<NetCaptureRecord[]>(store.index('by_host').getAll(host))
    return recs ?? []
  })
}

/** 某 host 当前记录数（上限断言 / UI 展示用） */
export async function countCapturesByHost(host: string): Promise<number> {
  return captureTx('readonly', async (_tx, store) => {
    return request<number>(store.index('by_host').count(host))
  })
}

/** 清空某 host 的全部采集记录 */
export async function clearCapturesByHost(host: string): Promise<void> {
  await captureTx('readwrite', async (tx, store) => {
    await eachHostRecord(store, host, (cursor) => {
      cursor.delete()
      return true
    })
    await txDone(tx, '清空录制数据失败')
  })
}

/** 已录过的全部 host（去重；索引键序，供摘要 / 查询界面枚举） */
export async function listCapturedHosts(): Promise<string[]> {
  return captureTx('readonly', async (_tx, store) => {
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

/** 归档一个已结束的会话（重复归档同一 id 即覆盖，标签页关闭与主动停止可能先后触发） */
export async function archiveSession(session: NetRecordSession): Promise<void> {
  await sessionTx('readwrite', async (tx, store) => {
    store.put(session)
    await txDone(tx, '保存录制会话失败')
  })
}

/** 某 host 的已归档会话（按开始时刻升序） */
export async function listSessionsByHost(host: string): Promise<NetRecordSession[]> {
  const list = await sessionTx('readonly', async (_tx, store) => {
    return request<NetRecordSession[]>(store.index('by_host').getAll(host))
  })
  return (list ?? []).sort((a, b) => a.startedAt - b.startedAt)
}

/** 有归档会话的全部 host（去重；录到 0 条请求的会话也该在查询界面有一行） */
export async function listSessionHosts(): Promise<string[]> {
  return sessionTx('readonly', async (_tx, store) => {
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

/** 清空某 host 的全部归档会话 */
export async function clearSessionsByHost(host: string): Promise<void> {
  await sessionTx('readwrite', async (tx, store) => {
    await eachHostRecord(store, host, (cursor) => {
      cursor.delete()
      return true
    })
    await txDone(tx, '清空录制会话失败')
  })
}

/**
 * 清空某 host 的全部录制数据（记录 + 归档会话）。
 * 两表同一事务：分两次清会留下「会话被打断在中间」的中间态，查询界面会短暂显示
 * 有记录没会话（或反之）。
 */
export async function clearHostData(host: string): Promise<void> {
  await idbRunTx(opener, [CAPTURE_STORE, SESSION_STORE], 'readwrite', async (tx) => {
    for (const name of [CAPTURE_STORE, SESSION_STORE]) {
      await eachHostRecord(tx.objectStore(name), host, (cursor) => {
        cursor.delete()
        return true
      })
    }
    await txDone(tx, '清空录制数据失败')
  })
}

// —— 测试辅助（仅单测使用；清空全部数据保证用例隔离）——

export async function clearAllForTests(): Promise<void> {
  await idbRunTx(opener, [CAPTURE_STORE, SESSION_STORE], 'readwrite', async (tx) => {
    tx.objectStore(CAPTURE_STORE).clear()
    tx.objectStore(SESSION_STORE).clear()
    await txDone(tx, '清空录制数据失败')
  })
}
