// 用户脚本「观测数据」的底层存储：独立 IndexedDB 库 duoling-runtime（SW 独占写）。
//
// 装三类数据（从 chrome.storage 迁入）：
//   · errors —— 错误日志环形（≤ ERROR_LOG_MAX 条）
//   · stats  —— 每脚本运行计数器（keyPath uuid，一脚本一记录）
//   · runlog —— 运行日志环形（≤ RUN_LOG_MAX 条）
//
// 与 duoling-usdata（脚本自己写的数据）分库：那边不可信、无上限、随脚本删除；
// 这边我们自己生成、有环形上限、随日志清理动作清空——信任级与演进节奏不同。
//
// errors / runlog 用「单记录数组」而不是逐条记录 + 自增键：两者都是有界环形，读取永远
// 全量（错误面板 / 时间线整块渲染），没有「单条定位」的读法，数组语义让裁剪/过滤逻辑
// 在调用方（store.ts）表达最自然；stats 反之，读取永远按 uuid 定点（挂摘要 / 记数）。
//
// 原子性：chrome.storage 时代 RMW（读全量→改→写回）靠进程内 promise 队列防丢更新；
// IDB 下读改写在**同一个事务**内完成，事务对同 store 天然串行，队列随之删除。
// recordRunStart 的「统计 + 日志一次写入」跨两个 store，用一个事务同时打开，原子性同保
// ——每次页面加载仍只付一次存储事务，写放大不因逐条日志翻倍。
//
// 单写方约定：写 API 只许 SW 调用（写侧全部经 store.ts 汇入）；广播不在此层——由调用方
// 在写成功后发（失败不发，且「无变化不落盘」时不发）。本模块不感知 chrome API，
// node 单测用 fake-indexeddb/auto 直测。

import type {
  UserScriptErrorRecord,
  UserScriptRunLogEntry,
  UserScriptRunStats,
} from './types'

const DB_NAME = 'duoling-runtime'
const DB_VERSION = 1

const ERRORS_STORE = 'errors'
const STATS_STORE = 'stats'
const RUNLOG_STORE = 'runlog'

/** errors / runlog 都是单记录数组：记录键固定为 'all'，value = { list } */
const ERRORS_REC_KEY = 'all'
const RUNLOG_REC_KEY = 'all'

interface ArrayRecord<T> {
  key: 'all'
  list: T[]
}

interface StatsRecord extends UserScriptRunStats {
  uuid: string
}

let dbPromise: Promise<IDBDatabase> | undefined

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        // errors / runlog 是单记录数组 store：in-line keyPath 'key'，全库只有一条 'all' 记录
        if (!db.objectStoreNames.contains(ERRORS_STORE)) {
          db.createObjectStore(ERRORS_STORE, { keyPath: 'key' })
        }
        if (!db.objectStoreNames.contains(STATS_STORE)) {
          db.createObjectStore(STATS_STORE, { keyPath: 'uuid' })
        }
        if (!db.objectStoreNames.contains(RUNLOG_STORE)) {
          db.createObjectStore(RUNLOG_STORE, { keyPath: 'key' })
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
      req.onerror = () => reject(req.error ?? new Error('无法打开运行数据'))
      req.onblocked = () => reject(new Error('运行数据被其它页面占用，无法升级'))
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
  storeNames: string | string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const names = Array.isArray(storeNames) ? storeNames : [storeNames]
  for (let attempt = 1; ; attempt++) {
    const db = await openDb()
    try {
      const tx = db.transaction(names, mode)
      return await run(tx)
    } catch (e) {
      dbPromise = undefined
      if (attempt < 2 && isDeadConnection(e)) continue
      throw e
    }
  }
}

/** 事务收尾：oncomplete 才算成功（put/delete 排队后必须等事务提交，错误才真正落定） */
function txDone(tx: IDBTransaction, what: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error(`${what}失败`))
    tx.onabort = () => reject(tx.error ?? new Error(`${what}被中止`))
  })
}

// —— 错误日志（errors store，单记录环形）——

/**
 * 读改写错误日志环形。fn 返回 null = 无变化不落盘（避免白写一次全量）。
 * 整个读改写在一个事务内，天然原子——崩溃风暴的并发 append 不会互相覆盖。
 * @returns 日志是否实际被改写（调用方据此决定要不要广播）
 */
export async function mutateErrors(
  fn: (cur: UserScriptErrorRecord[]) => UserScriptErrorRecord[] | null,
): Promise<boolean> {
  return runTx(ERRORS_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(ERRORS_STORE)
    const rec = await request<ArrayRecord<UserScriptErrorRecord> | undefined>(store.get(ERRORS_REC_KEY))
    const next = fn(rec?.list ?? [])
    if (next) store.put({ key: ERRORS_REC_KEY, list: next } satisfies ArrayRecord<UserScriptErrorRecord>)
    await txDone(tx, '写入错误日志')
    return next !== null
  })
}

/** 错误日志全量（落盘顺序 = 时间正序，最新在数组尾；最新在前的展示由调用方反转） */
export async function readErrors(): Promise<UserScriptErrorRecord[]> {
  const rec = await runTx(ERRORS_STORE, 'readonly', async (tx) => {
    return request<ArrayRecord<UserScriptErrorRecord> | undefined>(
      tx.objectStore(ERRORS_STORE).get(ERRORS_REC_KEY),
    )
  })
  return rec?.list ?? []
}

// —— 运行统计（stats store，每脚本一记录）——

/**
 * 读改写某脚本的运行统计。fn 返回 null = 无变化不落盘。
 * @returns 统计是否实际被改写（调用方据此决定要不要广播）
 */
export async function mutateStats(
  uuid: string,
  fn: (cur: UserScriptRunStats | undefined) => UserScriptRunStats | null,
): Promise<boolean> {
  return runTx(STATS_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(STATS_STORE)
    const rec = await request<StatsRecord | undefined>(store.get(uuid))
    const next = fn(rec)
    if (next) store.put({ ...next, uuid } satisfies StatsRecord)
    await txDone(tx, '写入运行统计')
    return next !== null
  })
}

/** 某脚本的运行统计（无统计返回 undefined，UI 据此不渲染该列） */
export async function getStats(uuid: string): Promise<UserScriptRunStats | undefined> {
  const rec = await runTx(STATS_STORE, 'readonly', async (tx) => {
    return request<StatsRecord | undefined>(tx.objectStore(STATS_STORE).get(uuid))
  })
  if (!rec) return undefined
  const { uuid: _ignored, ...st } = rec
  return st
}

/** 全部脚本的运行统计（uuid → 统计），供列表摘要批量挂载 */
export async function getAllRunStats(): Promise<Record<string, UserScriptRunStats>> {
  const recs = await runTx(STATS_STORE, 'readonly', async (tx) => {
    return request<StatsRecord[]>(tx.objectStore(STATS_STORE).getAll())
  })
  const out: Record<string, UserScriptRunStats> = {}
  for (const r of recs ?? []) {
    const { uuid, ...st } = r
    out[uuid] = st
  }
  return out
}

/** 删除某脚本的运行统计（删脚本时随 clearRunLog 一起调） */
export async function deleteStats(uuid: string): Promise<void> {
  await runTx(STATS_STORE, 'readwrite', async (tx) => {
    tx.objectStore(STATS_STORE).delete(uuid)
    await txDone(tx, '删除运行统计')
  })
}

// —— 运行日志（runlog store，单记录环形）——

/**
 * 读改写运行日志环形。fn 返回 null = 无变化不落盘。
 * @returns 日志是否实际被改写
 */
export async function mutateRunLog(
  fn: (cur: UserScriptRunLogEntry[]) => UserScriptRunLogEntry[] | null,
): Promise<boolean> {
  return runTx(RUNLOG_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(RUNLOG_STORE)
    const rec = await request<ArrayRecord<UserScriptRunLogEntry> | undefined>(store.get(RUNLOG_REC_KEY))
    const next = fn(rec?.list ?? [])
    if (next) store.put({ key: RUNLOG_REC_KEY, list: next } satisfies ArrayRecord<UserScriptRunLogEntry>)
    await txDone(tx, '写入运行日志')
    return next !== null
  })
}

/** 运行日志全量（落盘顺序 = 时间正序） */
export async function readRunLog(): Promise<UserScriptRunLogEntry[]> {
  const rec = await runTx(RUNLOG_STORE, 'readonly', async (tx) => {
    return request<ArrayRecord<UserScriptRunLogEntry> | undefined>(
      tx.objectStore(RUNLOG_STORE).get(RUNLOG_REC_KEY),
    )
  })
  return rec?.list ?? []
}

// —— 统计 + 日志跨 store 读改写（recordRunStart 专用）——

export interface StatsAndLogMutation {
  /** 新统计；null = 不写（如补播去重） */
  stats: UserScriptRunStats | null
  /** 新日志全量；null = 不写 */
  log: UserScriptRunLogEntry[] | null
  /** 本次是否实际记了账（决定调用方要不要广播） */
  recorded: boolean
}

/**
 * 统计与日志的合并读改写：一个事务同时打开两个 store，读改写全程原子——
 * 语义对齐 chrome.storage 时代的「一次 set 写两个键」。
 * @returns 是否实际记账（recordRunStart 据此决定要不要广播）
 */
export async function mutateStatsAndLog(
  uuid: string,
  fn: (stats: UserScriptRunStats | undefined, log: UserScriptRunLogEntry[]) => StatsAndLogMutation,
): Promise<boolean> {
  return runTx([STATS_STORE, RUNLOG_STORE], 'readwrite', async (tx) => {
    const statsStore = tx.objectStore(STATS_STORE)
    const logStore = tx.objectStore(RUNLOG_STORE)
    const [statsRec, logRec] = await Promise.all([
      request<StatsRecord | undefined>(statsStore.get(uuid)),
      request<ArrayRecord<UserScriptRunLogEntry> | undefined>(logStore.get(RUNLOG_REC_KEY)),
    ])
    const m = fn(statsRec, logRec?.list ?? [])
    if (m.stats) statsStore.put({ ...m.stats, uuid } satisfies StatsRecord)
    if (m.log) logStore.put({ key: RUNLOG_REC_KEY, list: m.log } satisfies ArrayRecord<UserScriptRunLogEntry>)
    await txDone(tx, '写入运行统计与日志')
    return m.recorded
  })
}

// —— 测试辅助（仅单测使用；清空全部记录保证用例隔离）——

export async function clearAllForTests(): Promise<void> {
  await runTx(ERRORS_STORE, 'readwrite', async (tx) => {
    tx.objectStore(ERRORS_STORE).clear()
    await txDone(tx, '清空错误日志')
  })
  await runTx(STATS_STORE, 'readwrite', async (tx) => {
    tx.objectStore(STATS_STORE).clear()
    await txDone(tx, '清空运行统计')
  })
  await runTx(RUNLOG_STORE, 'readwrite', async (tx) => {
    tx.objectStore(RUNLOG_STORE).clear()
    await txDone(tx, '清空运行日志')
  })
}
