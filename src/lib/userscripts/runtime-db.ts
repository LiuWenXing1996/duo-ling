// 用户脚本「观测数据」的底层存储：独立 IndexedDB 库 duoling-runtime（SW 独占写）。
//
// 装四类数据，全部「一条一记录」：
//   · errors     —— 错误日志（自增主键；环形 ≤ ERROR_LOG_MAX 条，插入序 = 时间序，裁最旧 = 删最小主键）
//   · stats      —— 每脚本运行计数器（keyPath uuid，一脚本一记录）
//   · runs       —— 运行条目（keyPath runId；环形 ≤ RUN_LOG_MAX 条，靠 by_time 索引裁最旧）
//   · run_events —— 运行内事件（自增主键 + by_runId 索引，随所属运行条被裁而级联删除）
//
// 为什么逐条而不是「单记录数组」：数组形状下任何一次追加都要读出整条记录、改完再整条写回
// （写放大 = 全量），上限因此被压得很小——500 条运行 × 上千条事件的量级根本走不通。
// 逐条后追加是 store.add、裁剪是索引 count + 游标 delete，读写都是 O(1)，上限只由
// 「存得下多少」决定。范式与 duoling-netlog 的 captures store 一致。
//
// 主键为什么两种：运行条目**有身份**——要被 endRuns 按 runId 定点回写 endedAt，
// 也要被 run_events / errors 引用，用身份做主键；errors / run_events 是纯流水
// （只追加、只按时间裁），用自增序号，裁剪就是「删最小的几个」。
//
// 级联删除：事件拆表后不再随运行条自动消失，三处必须显式做、且与主操作同一事务——
// ① runs 裁剪挤出最旧条目时 ② clearRuns 带 uuid ③ clearRuns 不带 uuid（清全部）。
//
// 迁移：v1 的 errors / runlog 是「单记录数组」形状（keyPath 'key'），与逐条形状的主键
// 不兼容，就地升级无从谈起——upgrade 里删表重建，旧观测数据一并丢弃（无长期价值）。
//
// 原子性：读改写在**同一个事务**内完成，事务对同 store 天然串行，无需进程内队列。
// startRun 的「统计 + 运行条 + 溢出裁剪」跨三个 store 用一个事务打开，原子性同保。
//
// 单写方约定：写 API 只许 SW 调用（写侧全部经 store.ts 汇入）；广播不在此层——由调用方
// 在写成功后发（失败不发，且「无变化不落盘」时不发）。本模块不感知 chrome API，
// node 单测用 fake-indexeddb/auto 直测。

import {
  ERROR_LOG_MAX,
  RUN_EVENT_MAX,
  RUN_LOG_MAX,
  type RunEndReason,
  type UserScriptErrorRecord,
  type UserScriptRunEvent,
  type UserScriptRunLogEntry,
  type UserScriptRunStats,
} from './types'
import { createIdbOpener, idbRequest as request, idbRunTx } from '../idb-core'

const DB_NAME = 'duoling-runtime'
const DB_VERSION = 2

const ERRORS_STORE = 'errors'
const STATS_STORE = 'stats'
const RUNS_STORE = 'runs'
const RUN_EVENTS_STORE = 'run_events'
/** v1 的运行日志 store 名（单记录数组形状），升级时删掉 */
const LEGACY_RUNLOG_STORE = 'runlog'

const RUNS_BY_TIME = 'by_time'
const RUNS_BY_UUID = 'by_uuid'
const EVENTS_BY_RUN = 'by_runId'

interface StatsRecord extends UserScriptRunStats {
  uuid: string
}

/** run_events 的记录体：事件本身 + 所属 runId（索引键） */
interface RunEventRecord extends UserScriptRunEvent {
  runId: string
}

const opener = createIdbOpener({
  name: DB_NAME,
  version: DB_VERSION,
  upgrade: (db) => {
    // v1 的 errors / runlog 与逐条形状的主键不同，就地升级无从谈起：删表重建，旧数据丢弃
    for (const name of [ERRORS_STORE, LEGACY_RUNLOG_STORE, RUNS_STORE, RUN_EVENTS_STORE]) {
      if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name)
    }
    db.createObjectStore(ERRORS_STORE, { autoIncrement: true })
    const runs = db.createObjectStore(RUNS_STORE, { keyPath: 'runId' })
    runs.createIndex(RUNS_BY_TIME, 'time') // 环形裁剪：按开始时刻找最旧
    runs.createIndex(RUNS_BY_UUID, 'uuid') // 清某脚本的运行条（连带它的事件）
    const events = db.createObjectStore(RUN_EVENTS_STORE, { autoIncrement: true })
    events.createIndex(EVENTS_BY_RUN, 'runId') // 按运行拉事件 / 级联删除
    // stats 是每脚本一记录、按 uuid 定点读写，形状没有变，保留不重建
    if (!db.objectStoreNames.contains(STATS_STORE)) {
      db.createObjectStore(STATS_STORE, { keyPath: 'uuid' })
    }
  },
  label: '运行数据',
})

function runTx<T>(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  return idbRunTx(opener, storeNames, mode, run)
}

/** 事务收尾：oncomplete 才算成功（put/delete 排队后必须等事务提交，错误才真正落定） */
function txDone(tx: IDBTransaction, what: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error(`${what}失败`))
    tx.onabort = () => reject(tx.error ?? new Error(`${what}被中止`))
  })
}

/**
 * 游标遍历骨架：onRecord 里删掉当前记录后 `continue()` 即可（游标 delete 不影响继续遍历）。
 * limit 为 Infinity 表示走到底。
 */
function eachCursor(
  req: IDBRequest<IDBCursorWithValue | null>,
  limit: number,
  onRecord: (cursor: IDBCursorWithValue) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let seen = 0
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor || seen >= limit) {
        resolve()
        return
      }
      seen += 1
      onRecord(cursor)
      cursor.continue()
    }
    req.onerror = () => reject(req.error ?? new Error('遍历本地记录失败'))
  })
}

/** 删掉某次运行的全部事件（级联删除的唯一落点） */
function deleteEventsOf(store: IDBObjectStore, runId: string): Promise<void> {
  return eachCursor(
    store.index(EVENTS_BY_RUN).openCursor(IDBKeyRange.only(runId)),
    Infinity,
    (cursor) => {
      cursor.delete()
    },
  )
}

// —— 错误日志（errors store，自增主键 + 环形）——

/**
 * 追加一条错误，并按主键序裁到 ERROR_LOG_MAX 条（插入序 = 时间序，裁最旧 = 删最小主键）。
 * 追加与裁剪同一事务，崩溃风暴下的并发 append 不会把上限冲破。
 */
export async function appendError(rec: UserScriptErrorRecord): Promise<void> {
  await runTx(ERRORS_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(ERRORS_STORE)
    const existing = await request<number>(store.count())
    store.add(rec)
    const excess = existing + 1 - ERROR_LOG_MAX
    if (excess > 0) await eachCursor(store.openCursor(), excess, (cursor) => cursor.delete())
    await txDone(tx, '写入错误日志')
  })
}

/** 错误日志全量（落盘顺序 = 时间正序，最新在记录尾；最新在前的展示由调用方反转） */
export async function listErrors(): Promise<UserScriptErrorRecord[]> {
  const recs = await runTx(ERRORS_STORE, 'readonly', async (tx) => {
    return request<UserScriptErrorRecord[]>(tx.objectStore(ERRORS_STORE).getAll())
  })
  return recs ?? []
}

/**
 * 按条件删错误。@returns 是否有记录被删（无变化不落盘，调用方据此决定要不要广播）
 */
export async function deleteErrors(
  where: (rec: UserScriptErrorRecord) => boolean,
): Promise<boolean> {
  return runTx(ERRORS_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(ERRORS_STORE)
    let removed = 0
    await eachCursor(store.openCursor(), Infinity, (cursor) => {
      if (!where(cursor.value as UserScriptErrorRecord)) return
      cursor.delete()
      removed += 1
    })
    await txDone(tx, '删除错误日志')
    return removed > 0
  })
}

// —— 运行统计（stats store，每脚本一记录）——

/**
 * 读改写某脚本的运行统计。fn 返回 null = 无变化不落盘（避免白写一次）。
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

/** 删除某脚本的运行统计（删脚本时随 clearRuns 一起调） */
export async function deleteStats(uuid: string): Promise<void> {
  await runTx(STATS_STORE, 'readwrite', async (tx) => {
    tx.objectStore(STATS_STORE).delete(uuid)
    await txDone(tx, '删除运行统计')
  })
}

// —— 运行条目（runs store，keyPath runId）——

/**
 * 登记一次运行开始：一个事务内写运行统计 + 运行条目，并在挤出最旧运行条时级联删它的事件。
 *
 * 同一 runId 的重复广播（engine 的 load 补救补播）按 stats.lastRunId 去重、整体跳过——
 * 补播若重置 lastRunErrors 会抹掉两次广播之间已上报的错误，故去重必须整体跳过。
 *
 * @returns 是否真的登记了（false = 补播去重，调用方不广播）
 */
export async function startRun(uuid: string, entry: UserScriptRunLogEntry): Promise<boolean> {
  return runTx([STATS_STORE, RUNS_STORE, RUN_EVENTS_STORE], 'readwrite', async (tx) => {
    const stats = tx.objectStore(STATS_STORE)
    const cur = await request<StatsRecord | undefined>(stats.get(uuid))
    if (cur?.lastRunId === entry.runId) {
      await txDone(tx, '写入运行统计与日志')
      return false
    }
    const runs = tx.objectStore(RUNS_STORE)
    const existing = await request<number>(runs.count())
    stats.put({
      uuid,
      totalRuns: (cur?.totalRuns ?? 0) + 1,
      lastRunAt: entry.time,
      lastRunId: entry.runId,
      lastRunErrors: 0,
    } satisfies StatsRecord)
    runs.put(entry)
    const excess = existing + 1 - RUN_LOG_MAX
    if (excess > 0) {
      const events = tx.objectStore(RUN_EVENTS_STORE)
      const victims: string[] = []
      await eachCursor(runs.index(RUNS_BY_TIME).openCursor(), excess, (cursor) => {
        victims.push((cursor.value as UserScriptRunLogEntry).runId)
        cursor.delete()
      })
      // 事件拆表后不再随运行条消失，必须显式级联删（同事务，避免留下孤儿事件）
      for (const runId of victims) await deleteEventsOf(events, runId)
    }
    await txDone(tx, '写入运行统计与日志')
    return true
  })
}

/**
 * 回写一批运行的结束（文档被导航替换 / 标签页被关时调用，见 background 的 tabs 监听）。
 *
 * 结束信号来自 tab 事件，此刻该次运行的记录**可能已被环形挤掉**（连开数百次页面），
 * 找不到就跳过。已带 endedAt 的条目不再改写（幂等），避免事件重入把时长越算越长。
 *
 * @param runIds 同一个 tab 当时跑着的全部运行（一个页面可能同时跑多个脚本）
 * @param reason 结束原因；与 endedAt 一起写入，成对出现
 * @returns 是否真有条目被改写（调用方据此决定要不要广播）
 */
export async function endRuns(
  runIds: string[],
  endedAt: number,
  reason: RunEndReason,
): Promise<boolean> {
  if (!runIds.length) return false
  return runTx(RUNS_STORE, 'readwrite', async (tx) => {
    const runs = tx.objectStore(RUNS_STORE)
    let touched = false
    for (const runId of runIds) {
      const run = await request<UserScriptRunLogEntry | undefined>(runs.get(runId))
      if (!run || run.endedAt != null) continue
      runs.put({ ...run, endedAt, endReason: reason })
      touched = true
    }
    await txDone(tx, '回写运行结束')
    return touched
  })
}

/** 运行条目全量（顺序为主键序，与时间无关；按时间排由调用方做） */
export async function listRuns(): Promise<UserScriptRunLogEntry[]> {
  const recs = await runTx(RUNS_STORE, 'readonly', async (tx) => {
    return request<UserScriptRunLogEntry[]>(tx.objectStore(RUNS_STORE).getAll())
  })
  return recs ?? []
}

/**
 * 清运行条目：不带 uuid = 清全部；带 uuid = 只清该脚本的。两者都级联删掉事件。
 * @returns 是否真有条目被删（调用方据此决定要不要广播）
 */
export async function clearRuns(uuid?: string): Promise<boolean> {
  return runTx([RUNS_STORE, RUN_EVENTS_STORE], 'readwrite', async (tx) => {
    const runs = tx.objectStore(RUNS_STORE)
    const events = tx.objectStore(RUN_EVENTS_STORE)
    const victims: string[] = []
    const cursor =
      uuid === undefined
        ? runs.openCursor()
        : runs.index(RUNS_BY_UUID).openCursor(IDBKeyRange.only(uuid))
    await eachCursor(cursor, Infinity, (c) => {
      victims.push((c.value as UserScriptRunLogEntry).runId)
      c.delete()
    })
    for (const runId of victims) await deleteEventsOf(events, runId)
    await txDone(tx, '清空运行日志')
    return victims.length > 0
  })
}

// —— 运行内事件（run_events store，自增主键 + by_runId 索引）——

/**
 * 追加一条运行事件，同事务内把该运行的 eventCount 加一。
 *
 * 找不到所属运行条（已被环形挤掉 / 压根没登记）即不写——事件是观察数据，
 * 不值得为它补造一条运行记录。达到 RUN_EVENT_MAX 后不再落盘事件，只继续涨计数
 * （读侧靠「计数 > 实存条数」看出被截断）。
 *
 * @returns 是否真的写入了事件（false = 已达上限或无主，调用方不必广播）
 */
export async function appendRunEvent(runId: string, event: UserScriptRunEvent): Promise<boolean> {
  return runTx([RUNS_STORE, RUN_EVENTS_STORE], 'readwrite', async (tx) => {
    const runs = tx.objectStore(RUNS_STORE)
    const run = await request<UserScriptRunLogEntry | undefined>(runs.get(runId))
    if (!run) {
      await txDone(tx, '写入运行事件')
      return false
    }
    const received = run.eventCount ?? 0
    const written = received < RUN_EVENT_MAX
    if (written) {
      tx.objectStore(RUN_EVENTS_STORE).add({ ...event, runId } satisfies RunEventRecord)
    }
    runs.put({ ...run, eventCount: received + 1 })
    await txDone(tx, '写入运行事件')
    return written
  })
}

/** 某次运行的全部事件（按发生先后升序：索引内同键按主键序 = 插入序 = 时间序） */
export async function listRunEvents(runId: string): Promise<UserScriptRunEvent[]> {
  const recs = await runTx(RUN_EVENTS_STORE, 'readonly', async (tx) => {
    return request<RunEventRecord[]>(
      tx.objectStore(RUN_EVENTS_STORE).index(EVENTS_BY_RUN).getAll(runId),
    )
  })
  return (recs ?? []).map(({ runId: _owner, ...event }) => event)
}

// —— 测试辅助（仅单测使用；清空全部记录保证用例隔离）——

export async function clearAllForTests(): Promise<void> {
  for (const name of [ERRORS_STORE, STATS_STORE, RUNS_STORE, RUN_EVENTS_STORE]) {
    await runTx(name, 'readwrite', async (tx) => {
      tx.objectStore(name).clear()
      await txDone(tx, '清空观测数据')
    })
  }
}
