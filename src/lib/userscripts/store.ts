// 用户脚本的 SW 侧持久化（写出口汇聚层）。
//
// 项目数据（源码/配置/产物/enabled）的权威在 IndexedDB 状态库 duoling-state
// （读侧 lib/userscripts/project-store.ts，写侧 project-write.ts，均不碰 chrome API）。
// 本文件管两块存储，全部落 IndexedDB：GM 值（duoling-usdata 库，见 usdata-db.ts）、
// 观测数据 = 错误日志 / 运行统计 / 运行条目 / 运行内事件（duoling-runtime 库，见 runtime-db.ts）。
//
// 观测数据的读改写在 runtime-db 的同一事务内完成（天然原子），故这里不再需要
// chrome.storage 时代的进程内串行队列；「无变化不落盘」语义原样保留，广播只在实际
// 写入后发。环形裁剪与拆表后的级联删除都在 runtime-db 内完成，本层只表达业务语义。
import {
  type RunEndReason,
  type ScriptProject,
  type ScriptSummary,
  type UserScriptErrorRecord,
  type UserScriptRunEvent,
  type UserScriptRunLogEntry,
  type UserScriptRunLogRow,
  type UserScriptRunStats,
} from './types'
import { broadcastDataChange } from '../data-broadcast'
import * as usdata from './usdata-db'
import * as runtime from './runtime-db'

/**
 * 列表视图：项目摘要（不含源码与构建产物），未启用在后、启用在前，组内按源码保存时间倒序。
 * 项目由调用方传入（读自状态库，见 background.ts）——本文件已不再持有项目数据。
 */
export async function listSummaries(projects: ScriptProject[]): Promise<ScriptSummary[]> {
  const projectSummaries: ScriptSummary[] = projects.map((p) => ({
    uuid: p.uuid,
    name: p.name,
    enabled: p.enabled,
    matches: p.config.matches ?? [],
    group: p.group ?? '',
    savedAt: p.source.savedAt,
  }))
  return [...projectSummaries].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || b.savedAt - a.savedAt,
  )
}

// —— GM 值存储（原 chrome.storage 键空间 us:gm:<uuid>:<key>，现落 duoling-usdata 库）——
//
// 写出口 = 本文件这几个函数（dl-bridge dispatch 是唯一调用方），store.watch 的变更
// 事件也从这里发（原经 storage.onChanged 兜底，IDB 无通知，改为写出口直发）。
// 语义保持：值未变化的 set、删除不存在的键都不发事件（与 storage.onChanged 行为一致）。

export interface GmValueChange {
  uuid: string
  key: string
  /** true = 键被删除（帧上 value 置 null）；false = 新值写入 */
  deleted: boolean
  /** 新值（deleted 时为 null）；随事件携带，订阅方免回读 */
  value: unknown
  /**
   * 变化前的值。支撑 `GM_addValueChangeListener(key, (k, oldValue, newValue, remote))` 的
   * 第二参；键不存在时为 undefined。
   */
  oldValue?: unknown
  /**
   * 发起写的实例 connId（包装层随 `store.set` 带上）。
   * 推送侧据此判 `remote`：与发起者同 connId 的 Port 是「本实例自己写的」（false），
   * 其余是「别的标签页 / 框架写的」（true）；缺省 = 来源未知（后台内部写）→ 一律按 remote 处理。
   */
  writerConnId?: string
}

type GmValueListener = (change: GmValueChange) => void

const gmValueListeners = new Set<GmValueListener>()

/** 订阅 GM 值变更（dl-port 的 store.watch 下行推送经此接线；返回退订函数） */
export function onGmValueChange(listener: GmValueListener): () => void {
  gmValueListeners.add(listener)
  return () => gmValueListeners.delete(listener)
}

function emitGmChange(change: GmValueChange): void {
  for (const cb of gmValueListeners) {
    try {
      cb(change)
    } catch {
      // 单个订阅者异常不阻断其它订阅者与写入本身
    }
  }
}

export async function getGMValue(uuid: string, key: string): Promise<unknown> {
  return usdata.getGmValue(uuid, key)
}

export async function setGMValue(
  uuid: string,
  key: string,
  value: unknown,
  writerConnId?: string,
): Promise<void> {
  const prev = await usdata.getGmValue(uuid, key)
  await usdata.setGmValue(uuid, key, value)
  // 值未变化不发事件（storage.onChanged 同款语义）；结构化克隆值按 Json 契约可比
  if (JSON.stringify(prev) !== JSON.stringify(value)) {
    // 可选字段只在有值时挂上 —— 事件要过结构化克隆过桥，留 undefined 键只会让帧更脏
    emitGmChange({
      uuid,
      key,
      deleted: false,
      value,
      ...(prev !== undefined ? { oldValue: prev } : {}),
      ...(writerConnId ? { writerConnId } : {}),
    })
  }
}

export async function deleteGMValue(
  uuid: string,
  key: string,
  writerConnId?: string,
): Promise<void> {
  const prev = await usdata.getGmValue(uuid, key)
  if (prev === undefined) return // 键本就不存在：不写不发事件（同 storage.remove）
  await usdata.deleteGmValue(uuid, key)
  emitGmChange({ uuid, key, deleted: true, value: null, oldValue: prev, ...(writerConnId ? { writerConnId } : {}) })
}

/**
 * 批量写（GM_setValues 的落点）：一次事务落盘，**逐键**发变更事件。
 *
 * 事件粒度照旧是「一键一帧」而不是「一批一帧」——订阅侧（`GM_addValueChangeListener`）
 * 的语义按 key 走，合成一帧它没法派发；且值没变化的键不发（与单键版同款）。
 */
export async function setGMValues(
  uuid: string,
  entries: Record<string, unknown>,
  writerConnId?: string,
): Promise<void> {
  const keys = Object.keys(entries)
  if (!keys.length) return
  const prev = await usdata.getGmValues(uuid, keys)
  await usdata.setGmValues(uuid, entries)
  for (const key of keys) {
    // 结构化克隆值按 Json 契约可比（同单键版的判据）
    if (JSON.stringify(prev[key]) === JSON.stringify(entries[key])) continue
    const oldValue = prev[key]
    emitGmChange({
      uuid,
      key,
      deleted: false,
      value: entries[key],
      ...(oldValue !== undefined ? { oldValue } : {}),
      ...(writerConnId ? { writerConnId } : {}),
    })
  }
}

/**
 * 批量删（GM_deleteValues 的落点）：一次事务落盘，只对**真删掉**的键逐键发删除事件。
 * 不存在的键静默跳过（同 deleteGMValue 的 storage.remove 语义）。
 */
export async function deleteGMValues(
  uuid: string,
  keys: string[],
  writerConnId?: string,
): Promise<void> {
  if (!keys.length) return
  const removed = await usdata.deleteGmValues(uuid, keys)
  for (const { key, oldValue } of removed) {
    emitGmChange({
      uuid,
      key,
      deleted: true,
      value: null,
      oldValue,
      ...(writerConnId ? { writerConnId } : {}),
    })
  }
}

/** 列出某脚本存过的全部键 */
export async function listGMKeys(uuid: string): Promise<string[]> {
  return usdata.listGmKeys(uuid)
}

/** 某脚本的全部键值快照（注入时的值预载 + 包装层全量校准用） */
export async function getAllGMValues(uuid: string): Promise<Record<string, unknown>> {
  return usdata.listGmValues(uuid)
}

/** 批量取若干键（`GM.getValues` 的落点）：只回存在的键，不把整份存储搬过桥 */
export async function getGMValues(uuid: string, keys: string[]): Promise<Record<string, unknown>> {
  return usdata.getGmValues(uuid, keys)
}

/**
 * 清空某脚本的全部存储值；被删的键逐个发删除事件（对齐 storage.onChanged 逐键语义）。
 *
 * **不带 oldValue**：批量操作不逐个回读旧值，订阅方的 oldValue 为 undefined（帧上是 null）。
 * 要精确的旧值请在 clear 前自己 listValues + getValue 读一遍。
 */
export async function clearGMValues(uuid: string, writerConnId?: string): Promise<void> {
  const deletedKeys = await usdata.clearGmValues(uuid)
  for (const key of deletedKeys) {
    // 逐个发删除事件（对齐 storage.onChanged 逐键语义）；被删的键必然有旧值
    emitGmChange({ uuid, key, deleted: true, value: null, ...(writerConnId ? { writerConnId } : {}) })
  }
}

// —— 错误日志（duoling-runtime 库 errors store，逐条 + 环形）——
//
// 运行期错误经 GM 包装转发到 onUserScriptMessage 后被收集；注册/桥失败在后台直接收集。
// 环形保留最近 N 条，避免无限增长（上限定义在 types.ts，供 UI 文案同源引用）。
// 追加 / 裁剪 / 删除都在 runtime-db 的事务内原子完成，无需进程内队列串行。

/** 追加一条错误（自动补 id；time 缺省用当前时间）。 */
export async function appendUserScriptError(
  // time 由本函数兜底（rec.time || Date.now()），故对调用方可选
  rec: Omit<UserScriptErrorRecord, 'id' | 'time'> & { id?: string; time?: number },
): Promise<void> {
  await runtime.appendError({
    ...rec,
    id: rec.id || crypto.randomUUID(),
    time: rec.time || Date.now(),
  })
  // 广播埋在这里而不是各个调用点：错误有 4 个上报入口（background 的注册兜底、
  // engine 两处、dl-bridge 的脚本消息转发），这里是唯一汇合点。
  // 崩溃风暴的高频 append 由广播侧的合并窗口（100ms）兜住，前端不会被打爆。
  broadcastDataChange('error', rec.uuid ?? undefined)
  // 运行期错误同步计入该脚本的「最近一次运行」错误数（独立事务，失败不影响错误记录本身）
  void noteRunError(rec.uuid ?? null, typeof rec.runId === 'string' ? rec.runId : null).catch(() => {})
}

/** 列出全部错误（最新在前） */
export async function listUserScriptErrors(): Promise<UserScriptErrorRecord[]> {
  return (await runtime.listErrors()).slice().reverse()
}

/**
 * 清空错误日志。
 *
 * @param uuid 缺省 = 清全部；字符串 = 只清该脚本的记录；**null = 只清「未归属」记录**
 *   （uuid 为 null 的那些：注册失败无脚本上下文、部分桥错误）。
 *   三态各自独立，故判定用 `=== undefined` 而非 falsy —— `null` 是有效目标，不是「没传」。
 */
export async function clearUserScriptErrors(uuid?: string | null): Promise<void> {
  if (uuid === undefined) {
    await runtime.deleteErrors(() => true)
    broadcastDataChange('error') // 全量清空
    return
  }
  // 没有该脚本（或该类）的记录即无变化：不广播
  const changed = await runtime.deleteErrors((e) => e.uuid === uuid)
  // null（未归属）没有单条 uuid 可指，按全量通知
  if (changed) broadcastDataChange('error', uuid ?? undefined)
}

/**
 * 按 id 查一条错误：精确 id，或至少 8 位的前缀唯一匹配。
 * 前缀下限 8 位：工作台展示的就是前 8 位（复制的是完整 id），前缀太短碰撞概率失控。
 * 多命中 = 前缀不唯一（ambiguous），调用方让用户复制完整 ID，绝不猜。
 */
export type UserScriptErrorLookup =
  | { found: true; record: UserScriptErrorRecord }
  | { found: false; reason: 'not-found' | 'ambiguous' }

export async function findUserScriptError(id: string): Promise<UserScriptErrorLookup> {
  const list = await listUserScriptErrors()
  const exact = list.find((e) => e.id === id)
  if (exact) return { found: true, record: exact }
  if (id.length < 8) return { found: false, reason: 'not-found' }
  const matches = list.filter((e) => e.id.startsWith(id))
  if (matches.length === 1) return { found: true, record: matches[0]! }
  if (matches.length > 1) return { found: false, reason: 'ambiguous' }
  return { found: false, reason: 'not-found' }
}

// —— 运行统计（stats store）与运行条目 / 运行内事件（runs / run_events store）——
//
// 统计 = 每脚本一个小计数器对象；运行条 = 一条一次运行（keyPath runId）；
// 运行内事件 = 一条一个动作（按 runId 索引，展开某次运行时才拉）。
// 登记运行开始把「统计 + 运行条 + 溢出裁剪」并进同一事务写入（runtime.startRun）：
// 每次页面加载仍只付一次存储事务，逐条落盘不额外放大写入。「无变化不落盘」：
// 补播去重 / 已结束条目重复回写都直接跳过，不写也不广播。

/**
 * 登记一次运行开始（dl-bridge 收到 __dlRunStart 广播时调用，有无 tabId 都记）。
 * 同一 runId 的重复广播（engine 的 load 补救补播）按 lastRunId 去重，是 no-op——
 * 补播若重置 lastRunErrors 会抹掉两次广播之间已上报的错误，故去重必须整体跳过
 * （运行条目也随之不重复追加）。
 *
 * @param extra 运行所在页面、注入时的源码版本（见 UserScriptRunLogEntry）与所在标签页的存续 id：
 *   都是「这次运行到底跑的是哪一版、在哪一页、在哪个标签页」的定位线索，缺省即不写该字段。
 */
export function recordRunStart(
  uuid: string,
  runId: string,
  name?: string,
  extra?: { url?: string; savedAt?: number; tabSessionId?: string },
): Promise<void> {
  const entry: UserScriptRunLogEntry = {
    runId,
    uuid,
    // name 快照由调用方传（dl-bridge 手上有注册表）；没传就留空，UI 回退短 uuid
    name: name ?? '',
    time: Date.now(),
    ...(extra?.url != null ? { url: extra.url } : {}),
    ...(extra?.savedAt != null ? { savedAt: extra.savedAt } : {}),
    ...(extra?.tabSessionId != null ? { tabSessionId: extra.tabSessionId } : {}),
  }
  return runtime.startRun(uuid, entry).then((recorded) => {
    // 管理页的运行统计列与运行日志标签页靠这条广播实时回拉（合并窗口防导航风暴）
    if (recorded) broadcastDataChange('runstats', uuid)
  })
}

/**
 * 追加一条运行内事件（dl-bridge 的 dispatch 采集后调用）。
 *
 * 事件逐条落在 run_events，同事务内把所属运行条目的 eventCount 加一；找不到所属运行条
 * （已被环形挤掉、或该次运行压根没登记）即 no-op —— 事件是观察数据，不值得为它补造
 * 一条运行记录。到 RUN_EVENT_MAX 后不再落盘事件本体，只涨计数（读侧据此说明「已省略」）。
 */
export function recordRunEvent(uuid: string, runId: string, event: UserScriptRunEvent): Promise<void> {
  return runtime.appendRunEvent(runId, event).then((written) => {
    // 到上限后不再有新事件落盘，也就不必再让面板白回拉一次
    if (written) broadcastDataChange('runstats', uuid)
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
 */
export function markRunEnd(runIds: string[], reason: RunEndReason): Promise<void> {
  return runtime.endRuns(runIds, Date.now(), reason).then((changed) => {
    if (changed) broadcastDataChange('runstats')
  })
}

/**
 * 运行期错误计入「最近一次运行」的错误数（appendUserScriptError 的汇合点调用）。
 * 仅当错误带 uuid + runId 且 runId 与最近一次运行一致才计数——旧运行的迟到错误、
 * register/bridge 类无运行上下文的错误都不算（后者不是「脚本运行挂了」）。
 */
export function noteRunError(uuid: string | null, runId: string | null): Promise<void> {
  if (!uuid || !runId) return Promise.resolve()
  return runtime
    .mutateStats(uuid, (cur) => {
      // 从未登记过运行（runstart 丢失 / 尚未处理）或错误属于更早的运行：不计
      if (!cur || cur.lastRunId !== runId) return null
      return { ...cur, lastRunErrors: (cur.lastRunErrors ?? 0) + 1 }
    })
    .then((changed) => {
      if (changed) broadcastDataChange('runstats', uuid)
    })
}

/** 给列表摘要挂上运行统计（无统计的脚本保持缺省，UI 据此不渲染该列） */
export async function withRunStats(summaries: ScriptSummary[]): Promise<ScriptSummary[]> {
  if (!summaries.length) return summaries
  const all = await runtime.getAllRunStats()
  const byUuid = new Map<string, UserScriptRunStats>()
  for (const s of summaries) {
    const st = all[s.uuid]
    if (st) byUuid.set(s.uuid, st)
  }
  if (!byUuid.size) return summaries
  return summaries.map((s) => {
    const st = byUuid.get(s.uuid)
    if (!st) return s
    return {
      ...s,
      runCount: st.totalRuns,
      ...(st.lastRunAt ? { lastRunAt: st.lastRunAt } : {}),
      // 只在有错误时带出：UI 的「最近错误」标只在 >0 时渲染，语义单一
      ...(st.lastRunErrors ? { lastRunErrors: st.lastRunErrors } : {}),
    }
  })
}

/**
 * 运行日志时间线：运行行（runs）+ 无法归属的错误行（errors 里 runId 落空 /
 * 无 runId 的记录）按时间倒序混排。运行期错误按 runId 挂到所属运行行上（不复制明细）。
 *
 * **不带运行内事件**：事件单独一表，跟着运行数全量读会线性膨胀（500 次运行 × 上限
 * 1000 条）；运行行只带 eventCount，展开某次运行时再经 listRunEvents 拉一次。
 */
export async function listRunTimeline(): Promise<UserScriptRunLogRow[]> {
  const [runs, errors] = await Promise.all([runtime.listRuns(), listUserScriptErrors()])
  const runIds = new Set(runs.map((r) => r.runId))
  const byRun = new Map<string, UserScriptErrorRecord[]>()
  const loose: UserScriptErrorRecord[] = []
  for (const e of errors) {
    if (e.runId && runIds.has(e.runId)) {
      const bucket = byRun.get(e.runId)
      if (bucket) bucket.push(e)
      else byRun.set(e.runId, [e])
    } else {
      loose.push(e)
    }
  }
  const rows: UserScriptRunLogRow[] = [
    ...runs.map((r) => ({
      kind: 'run' as const,
      runId: r.runId,
      uuid: r.uuid,
      name: r.name,
      time: r.time,
      // 老记录没有这些字段：缺了就整条不写，保持「无值 = 字段不存在」的一致口径
      ...(r.url != null ? { url: r.url } : {}),
      ...(r.tabSessionId != null ? { tabSessionId: r.tabSessionId } : {}),
      ...(r.savedAt != null ? { savedAt: r.savedAt } : {}),
      ...(r.eventCount != null ? { eventCount: r.eventCount } : {}),
      ...(r.endedAt != null ? { endedAt: r.endedAt } : {}),
      ...(r.endReason != null ? { endReason: r.endReason } : {}),
      errors: byRun.get(r.runId) ?? [],
    })),
    ...loose.map((e) => ({ kind: 'error' as const, record: e })),
  ]
  return rows.sort((a, b) => (b.kind === 'run' ? b.time : b.record.time) - (a.kind === 'run' ? a.time : a.record.time))
}

/**
 * 某次运行的全部事件（按发生先后升序）。
 * 面板与 AI 都只在要看「这次运行干了什么」时调它——列表视图不带事件。
 */
export async function listRunEvents(runId: string): Promise<UserScriptRunEvent[]> {
  return runtime.listRunEvents(runId)
}

/**
 * 清运行条目（各自的事件一并级联删除，在 runtime-db 内同一事务完成）。
 * @param uuid 缺省 = 清全部；字符串 = 只清该脚本的条目；null = no-op
 *   （运行条必带 uuid，「未归属」只存在于错误日志，由 clearUserScriptErrors 管）。
 */
export function clearRunLog(uuid?: string | null): Promise<void> {
  if (uuid === null) return Promise.resolve()
  return runtime.clearRuns(uuid ?? undefined).then((changed) => {
    if (changed) broadcastDataChange('runstats')
  })
}

/** 删除脚本时清掉它的运行统计与运行条目（与 clearGMValues / clearUserScriptErrors 同一条删除语义） */
export function clearRunStats(uuid: string): Promise<void> {
  return Promise.all([runtime.deleteStats(uuid), clearRunLog(uuid)]).then(() => {})
}

/**
 * 「活动历史」删掉某一页的全部活动 —— 存续行 + 它的运行条目（连带事件与错误）。
 *
 * 三层一起删是刻意的：面板展示的是它们的合成。只删存续行，这一页会以「表里已查不到」的
 * 残影留在列表里（它的运行还在）；只删运行，则留下一个空壳行。错误不带 tabSessionId，
 * 只能拿运行条上的 runIds 反查（与 listRunTimeline 同一口径）。
 */
export async function deleteTabActivity(tabSessionId: string): Promise<void> {
  const runIds = new Set(await runtime.clearRunsByTabSession([tabSessionId]))
  const rowsChanged = await runtime.clearTabSessions([tabSessionId])
  const errorsChanged = runIds.size
    ? await runtime.deleteErrors((e) => !!e.runId && runIds.has(e.runId))
    : false
  if (runIds.size || rowsChanged) broadcastDataChange('runstats')
  if (errorsChanged) broadcastDataChange('error')
}

/**
 * 「活动历史」清空全部 —— 存续行 + 运行日志 + 错误。
 *
 * 范围含「未知标签页」档（没开记录的页留下的运行与无 runId 的错误）：这个面板把它们也
 * 列了出来，清空自当一并清掉，否则清完左栏还留着那一档。
 */
export async function clearTabActivity(): Promise<void> {
  const runsChanged = await runtime.clearRuns()
  const rowsChanged = await runtime.clearTabSessions()
  const errorsChanged = await runtime.deleteErrors(() => true)
  if (runsChanged || rowsChanged) broadcastDataChange('runstats')
  if (errorsChanged) broadcastDataChange('error')
}
