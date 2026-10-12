// 用户脚本「观测数据」的底层存储：独立 IndexedDB 库 duoling-runtime（SW 独占写）。
//
// 装五类数据，全部「一条一记录」：
//   · errors     —— 错误日志（自增主键；环形 ≤ ERROR_LOG_MAX 条，插入序 = 时间序，裁最旧 = 删最小主键）
//   · stats      —— 每脚本运行计数器（keyPath uuid，一脚本一记录）
//   · runs       —— 运行条目（keyPath runId；环形 ≤ RUN_LOG_MAX 条，靠 by_time 索引裁最旧）
//   · run_events —— 运行内事件（自增主键 + by_runId 索引，随所属运行条被裁而级联删除）
//   · tab_sessions —— 标签页存续（keyPath tabSessionId；环形 ≤ TAB_SESSION_MAX 条，靠 by_seen 索引裁最旧的
//                      **已结束**行 —— 还开着的行不裁，见 trimEndedTabSessions）
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
// tab_sessions 是 v3 新增，同样走这次删表重建（旧日志随之清空，是刻意的）。
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
  TAB_SESSION_MAX,
  type RunEndReason,
  type TabSessionRecord,
  type UserScriptErrorRecord,
  type UserScriptRunEvent,
  type UserScriptRunLogEntry,
  type UserScriptRunStats,
} from './types'
import { createIdbOpener, idbRequest as request, idbRunTx } from '../idb-core'

const DB_NAME = 'duoling-runtime'
const DB_VERSION = 3

const ERRORS_STORE = 'errors'
const STATS_STORE = 'stats'
const RUNS_STORE = 'runs'
const RUN_EVENTS_STORE = 'run_events'
const TAB_SESSIONS_STORE = 'tab_sessions'
/** v1 的运行日志 store 名（单记录数组形状），升级时删掉 */
const LEGACY_RUNLOG_STORE = 'runlog'

const RUNS_BY_TIME = 'by_time'
const RUNS_BY_UUID = 'by_uuid'
const EVENTS_BY_RUN = 'by_runId'
const TABS_BY_TAB = 'by_tabId'
const TABS_BY_SEEN = 'by_seen'

interface StatsRecord extends UserScriptRunStats {
  uuid: string
}

/** run_events 的记录体：事件本身 + 所属 runId（索引键） */
interface RunEventRecord extends UserScriptRunEvent {
  runId: string
}

/**
 * tab_sessions 的记录体 = 公开类型 + 一个内部字段。
 * `firstSeenAt` 只用于裁剪排序（「谁先登记的」），不是给用户看的时刻——公开类型里不含它，
 * 免得读侧误以为它是「标签页出生时刻」（那得看 createdAt）。
 */
interface TabSessionRow extends TabSessionRecord {
  firstSeenAt: number
}

const opener = createIdbOpener({
  name: DB_NAME,
  version: DB_VERSION,
  upgrade: (db) => {
    // v1 的 errors / runlog 与逐条形状的主键不同，就地升级无从谈起：删表重建，旧数据丢弃
    for (const name of [
      ERRORS_STORE,
      LEGACY_RUNLOG_STORE,
      RUNS_STORE,
      RUN_EVENTS_STORE,
      TAB_SESSIONS_STORE,
    ]) {
      if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name)
    }
    db.createObjectStore(ERRORS_STORE, { autoIncrement: true })
    const runs = db.createObjectStore(RUNS_STORE, { keyPath: 'runId' })
    runs.createIndex(RUNS_BY_TIME, 'time') // 环形裁剪：按开始时刻找最旧
    runs.createIndex(RUNS_BY_UUID, 'uuid') // 清某脚本的运行条（连带它的事件）
    const events = db.createObjectStore(RUN_EVENTS_STORE, { autoIncrement: true })
    events.createIndex(EVENTS_BY_RUN, 'runId') // 按运行拉事件 / 级联删除
    const tabs = db.createObjectStore(TAB_SESSIONS_STORE, { keyPath: 'tabSessionId' })
    tabs.createIndex(TABS_BY_TAB, 'tabId') // 实时判据：按 tabId 找还开着的那一行
    tabs.createIndex(TABS_BY_SEEN, 'firstSeenAt') // 环形裁剪：按登记先后找最旧
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

// —— 标签页存续（tab_sessions store，keyPath tabSessionId）——
//
// 这张表给 tabId 一个稳定替身：别的面引用 tabSessionId、不引用 tabId（理由见 TabSessionRecord）。
// 时刻一律「记得到就记」，故这里没有任何补造逻辑 —— 缺省的字段就是未知，读侧如实显示。

/**
 * 建一行（取号）。
 *
 * 只有两处会调它：用户给这一页打开活动记录、脚本在这一页跑起来（取号逻辑见 tab-sessions）。
 * 两者都不是标签页出生的时刻，故**不写 `createdAt`** —— 没看着它出生就是不知道。
 *
 * @returns 新行的 tabSessionId
 */
export async function mintTabSession(input: {
  tabId: number
  url?: string
  /** 建行即开启记录（popup 的开关走这条）；缺省 = 这行只作历史起点，不接着记 */
  recording?: boolean
}): Promise<string> {
  const tabSessionId = crypto.randomUUID()
  await runTx(TAB_SESSIONS_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(TAB_SESSIONS_STORE)
    const existing = await request<number>(store.count())
    store.put({
      tabSessionId,
      tabId: input.tabId,
      ...(input.url ? { url: input.url } : {}),
      ...(input.recording ? { recording: true } : {}),
      firstSeenAt: Date.now(),
    } satisfies TabSessionRow)
    const excess = existing + 1 - TAB_SESSION_MAX
    if (excess > 0) await trimEndedTabSessions(store, excess)
    await txDone(tx, '登记标签页')
  })
  return tabSessionId
}

/**
 * 该 tabId 现在开着的那一行。同一浏览器会话内至多一行 —— 跨会话的残留行已由 endOpenTabSessions 盖章，
 * 同会话内同一 tabId 只会在缺失时补建一次（见 tab-sessions 的取号策略）。
 */
export async function findOpenTabSession(tabId: number): Promise<TabSessionRecord | undefined> {
  const row = await runTx(TAB_SESSIONS_STORE, 'readonly', async (tx) =>
    openRowOf(tx.objectStore(TAB_SESSIONS_STORE), tabId),
  )
  return row ? toPublic(row) : undefined
}

/**
 * 记下这个标签页最近的地址（`tabs.onUpdated` 带回 url 时调）。
 * @returns 是否真改到了（表里没有它、或地址没变 → false，不落盘）
 */
export async function setTabSessionUrl(tabId: number, url: string): Promise<boolean> {
  return runTx(TAB_SESSIONS_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(TAB_SESSIONS_STORE)
    const row = await openRowOf(store, tabId)
    if (!row || row.url === url) {
      await txDone(tx, '记录标签页地址')
      return false
    }
    store.put({ ...row, url })
    await txDone(tx, '记录标签页地址')
    return true
  })
}

/**
 * 打开 / 关掉这一页的活动记录（popup 的开关）。
 *
 * 只改还开着的那一行：行已结束说明这个 tabId 早已不是当初那页，改它就是改错人。
 * **关掉不删行** —— 历史留着，只是不再长出新记录。
 *
 * 关掉时把字段整个删掉而非写 false：缺省即「没开」，读侧（取号与概览）只有一条判据。
 *
 * @returns 是否真改到了（没这行、或本来就是这个值 → false，不落盘）
 */
export async function setTabSessionRecording(tabId: number, recording: boolean): Promise<boolean> {
  return runTx(TAB_SESSIONS_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(TAB_SESSIONS_STORE)
    const row = await openRowOf(store, tabId)
    if (!row || (row.recording === true) === recording) {
      await txDone(tx, '切换标签页记录')
      return false
    }
    const { recording: _wasOn, ...rest } = row
    store.put(recording ? { ...rest, recording: true } : rest)
    await txDone(tx, '切换标签页记录')
    return true
  })
}

/**
 * 盖上关闭时刻（`tabs.onRemoved` 调）。表里没有这个标签页就什么都不做 —— 没登记过的标签页
 * 不需要一条幽灵行（它连出生时刻都没有，留着只会占位与占上限）。
 * @returns 是否真有条目被改写（调用方据此决定要不要广播）
 */
export async function closeTabSession(tabId: number, closedAt: number): Promise<boolean> {
  return runTx(TAB_SESSIONS_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(TAB_SESSIONS_STORE)
    const row = await openRowOf(store, tabId)
    if (!row) {
      await txDone(tx, '标记标签页关闭')
      return false
    }
    store.put({ ...row, ended: true, closedAt })
    await txDone(tx, '标记标签页关闭')
    return true
  })
}

/**
 * 浏览器启动划断：把所有还「开着」的行盖章结束，**时刻留空**（它究竟何时关的，没人知道）。
 *
 * 为什么必须做：tabId 是浏览器本次运行内的流水号，重启后重排、且会被复用。不划断的话，
 * 上个会话残留的未结束行会与新会话里同号的标签页撞在一起（新标签页的运行被挂到旧行上）。
 *
 * 只在 `runtime.onStartup` 调，**不在 SW 冷启动调** —— 冷启动时那些「未结束」的行正是本会话
 * 还开着的标签页，那时盖章等于把活账全结掉。
 *
 * @returns 被盖章的行数
 */
export async function endOpenTabSessions(): Promise<number> {
  return runTx(TAB_SESSIONS_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(TAB_SESSIONS_STORE)
    let ended = 0
    // 用 cursor.update 就地改写：同事务内 put 同一主键会让游标重访该记录
    await eachCursor(store.openCursor(), Infinity, (cursor) => {
      const row = cursor.value as TabSessionRow
      if (row.ended === true) return
      cursor.update({ ...row, ended: true } satisfies TabSessionRow)
      ended += 1
    })
    await txDone(tx, '划断标签页存续')
    return ended
  })
}

/** 全量表（按登记先后升序）。消费方：运行日志按标签页分组时取名字与时刻 */
export async function listTabSessions(): Promise<TabSessionRecord[]> {
  const rows = await runTx(TAB_SESSIONS_STORE, 'readonly', async (tx) =>
    request<TabSessionRow[]>(tx.objectStore(TAB_SESSIONS_STORE).index(TABS_BY_SEEN).getAll()),
  )
  return (rows ?? []).map(toPublic)
}

/** 剥掉内部字段：裁剪排序键不该出现在任何读侧结果里（它不是用户能理解的时刻） */
function toPublic({ firstSeenAt: _trimKey, ...row }: TabSessionRow): TabSessionRecord {
  return row
}

/** 该 tabId 现在开着的那一行（未结束 = 还开着；已盖章的不算） */
async function openRowOf(store: IDBObjectStore, tabId: number): Promise<TabSessionRow | undefined> {
  const rows = await request<TabSessionRow[]>(store.index(TABS_BY_TAB).getAll(tabId))
  return (rows ?? []).find((r) => r.ended !== true)
}

/**
 * 裁掉最旧登记的**已结束**行，直到删够 excess 条。
 *
 * 未结束的行一律跳过：那是还开着的账，删掉等于凭空丢掉正在开的标签页。极端情况（未结束的行
 * 比上限还多）会删不满，那就到此为止 —— 宁可暂时超一点，也不动活账。
 */
function trimEndedTabSessions(store: IDBObjectStore, excess: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let removed = 0
    const req = store.index(TABS_BY_SEEN).openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor || removed >= excess) {
        resolve()
        return
      }
      if ((cursor.value as TabSessionRow).ended === true) {
        cursor.delete()
        removed += 1
      }
      cursor.continue()
    }
    req.onerror = () => reject(req.error ?? new Error('裁剪标签页存续表失败'))
  })
}

// —— 测试辅助（仅单测使用；清空全部记录保证用例隔离）——

/**
 * 灌入成表的行（**绕开取号与裁剪**），给环形裁剪用例备料。
 *
 * 为什么要它：裁剪只在表满时才触发，逐条走取号得先建满整条上限才够得着那个边界，
 * 而那条路自有别的用例覆盖；这里要测的只是「表满之后裁剪挑了哪几条」。
 *
 * 入参顺序 = 由旧到新：`firstSeenAt` 按顺序递增（它就是裁剪排序键）。
 */
export async function seedTabSessionsForTests(
  rows: Array<{ tabId: number; ended?: boolean }>,
): Promise<void> {
  await runTx(TAB_SESSIONS_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(TAB_SESSIONS_STORE)
    rows.forEach((row, i) => {
      store.put({
        tabSessionId: crypto.randomUUID(),
        tabId: row.tabId,
        ...(row.ended ? { ended: true } : {}),
        firstSeenAt: i,
      } satisfies TabSessionRow)
    })
    await txDone(tx, '灌入标签页存续数据')
  })
}

export async function clearAllForTests(): Promise<void> {
  for (const name of [ERRORS_STORE, STATS_STORE, RUNS_STORE, RUN_EVENTS_STORE, TAB_SESSIONS_STORE]) {
    await runTx(name, 'readwrite', async (tx) => {
      tx.objectStore(name).clear()
      await txDone(tx, '清空观测数据')
    })
  }
}
