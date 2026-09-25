// 用户脚本的 SW 侧持久化（写出口汇聚层）。
//
// 项目数据（源码/配置/产物/enabled）的权威在 IndexedDB 状态库 duoling-state
// （读侧 lib/userscripts/project-store.ts，写侧 project-write.ts，均不碰 chrome API）。
// 本文件管三块，全部落 IndexedDB：GM 值（duoling-usdata 库，见 usdata-db.ts）、
// 观测数据 = 错误日志 / 运行统计 / 运行日志（duoling-runtime 库，见 runtime-db.ts）。
//
// 观测数据的读改写在 runtime-db 的同一事务内完成（天然原子），故这里不再需要
// chrome.storage 时代的进程内串行队列；「无变化不落盘」语义原样保留，广播只在实际
// 写入后发。
import {
  ERROR_LOG_MAX,
  RUN_LOG_MAX,
  type ScriptProject,
  type ScriptSummary,
  type UserScriptErrorRecord,
  type UserScriptRunLogEntry,
  type UserScriptRunLogRow,
  type UserScriptRunStats,
} from './types'
import { broadcastDataChange } from '../data-broadcast'
import * as usdata from './usdata-db'
import * as runtime from './runtime-db'

/**
 * 列表视图：项目摘要（不含源码与构建产物），未启用在后、启用在前，组内按更新时间倒序。
 * 项目由调用方传入（读自状态库，见 background.ts）——本文件已不再持有项目数据。
 */
export async function listSummaries(projects: ScriptProject[]): Promise<ScriptSummary[]> {
  const projectSummaries: ScriptSummary[] = projects.map((p) => ({
    uuid: p.uuid,
    name: p.name,
    enabled: p.enabled,
    matches: p.config.matches ?? [],
    group: p.group ?? '',
    updatedAt: p.updatedAt,
  }))
  return [...projectSummaries].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || b.updatedAt - a.updatedAt,
  )
}

// —— GM 值存储（原 chrome.storage 键空间 us:gm:<uuid>:<key>，现落 duoling-usdata 库）——
//
// 写出口 = 本文件这几个 GM 值函数；自研 GM 桥废弃后写 API 改由 VM 负责（Phase D），store.watch 的变更
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
   * 第二参；键原先不存在时为 undefined。
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

// —— 错误日志（duoling-runtime 库 errors store，环形）——
//
// 运行期错误经 GM 包装转发到 onUserScriptMessage 后被收集；注册/桥失败在后台直接收集。
// 环形保留最近 N 条，避免无限增长（上限定义在 types.ts，供 UI 文案同源引用）。
// 读改写在 runtime.mutateErrors 的事务内原子完成，无需进程内队列串行。

/** 追加一条错误（自动补 id；time 缺省用当前时间）。 */
export async function appendUserScriptError(
  // time 由本函数兜底（rec.time || Date.now()），故对调用方可选
  rec: Omit<UserScriptErrorRecord, 'id' | 'time'> & { id?: string; time?: number },
): Promise<void> {
  await runtime.mutateErrors((existing) => {
    const next = existing.slice(-(ERROR_LOG_MAX - 1))
    next.push({ ...rec, id: rec.id || crypto.randomUUID(), time: rec.time || Date.now() })
    return next
  })
  // 广播埋在这里而不是各个调用点：错误上报入口曾分布在 engine / dl-bridge / background，
  // 随 P4 自研链路废弃已收敛，现仅 background 的注册兜底在此汇合；
  // 崩溃风暴的高频 append 由广播侧的合并窗口（100ms）兜住，前端不会被打爆。
  broadcastDataChange('error', rec.uuid ?? undefined)
  // 运行期错误同步计入该脚本的「最近一次运行」错误数（独立事务，失败不影响错误记录本身）
  void noteRunError(rec.uuid ?? null, typeof rec.runId === 'string' ? rec.runId : null).catch(() => {})
}

/** 列出全部错误（最新在前） */
export async function listUserScriptErrors(): Promise<UserScriptErrorRecord[]> {
  return (await runtime.readErrors()).slice().reverse()
}

/**
 * 清空错误日志（读改写原子，不存在「清空被并发写回覆盖」问题）。
 *
 * @param uuid 缺省 = 清全部；字符串 = 只清该脚本的记录；**null = 只清「未归属」记录**
 *   （uuid 为 null 的那些：注册失败无脚本上下文、部分桥错误）。
 *   三态各自独立，故判定用 `=== undefined` 而非 falsy —— `null` 是有效目标，不是「没传」。
 */
export async function clearUserScriptErrors(uuid?: string | null): Promise<void> {
  if (uuid === undefined) {
    await runtime.mutateErrors(() => [])
    broadcastDataChange('error') // 全量清空
    return
  }
  const changed = await runtime.mutateErrors((existing) => {
    const kept = existing.filter((e) => e.uuid !== uuid)
    // 没有该脚本的记录就不写回：RMW 的「无变化不落盘」语义，避免白写一次全量
    return kept.length === existing.length ? null : kept
  })
  // null（未归属）没有单条 uuid 可指，按全量通知；无变化不广播
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

// —— 运行统计（runtime 库 stats store，每脚本一记录）与运行日志（runtime 库 runlog store，环形）——
//
// 统计 = 每脚本一个小计数器对象；日志 = 全局环形按时间记「哪次运行发生了」。
// 两者在 recordRunStart 里**并进同一事务写入**（mutateStatsAndLog 跨两个 store）：
// 每次页面加载只付一次存储事务，逐条日志不额外放大写入。「无变化不落盘」：
// 补播去重 / 旧运行迟到错误直接返回 null，不写也不广播。

/**
 * 登记一次运行开始（运行监控改由 VM adapter 触发，见 Phase D；有无 tabId 都记）。
 * 同一 runId 的重复广播（engine 的 load 补救补播）按 lastRunId 去重，是 no-op——
 * 补播若重置 lastRunErrors 会抹掉两次广播之间已上报的错误，故去重必须整体跳过
 * （运行日志条目也随之不重复追加）。
 */
export function recordRunStart(uuid: string, runId: string, name?: string): Promise<void> {
  return runtime
    .mutateStatsAndLog(uuid, (cur, log) => {
      if (cur?.lastRunId === runId) return { stats: null, log: null, recorded: false } // 同一次运行的补播
      // name 快照由调用方传（VM adapter 在 Phase D 触发时带注册表名）；没传就留空，UI 回退短 uuid
      const logNext: UserScriptRunLogEntry[] = [
        ...log.slice(-(RUN_LOG_MAX - 1)),
        { runId, uuid, name: name ?? '', time: Date.now() },
      ]
      const next: UserScriptRunStats = {
        totalRuns: (cur?.totalRuns ?? 0) + 1,
        lastRunAt: Date.now(),
        lastRunId: runId,
        lastRunErrors: 0,
      }
      return { stats: next, log: logNext, recorded: true }
    })
    .then((recorded) => {
      // 管理页的运行统计列与运行日志标签页靠这条广播实时回拉（合并窗口防导航风暴）
      if (recorded) broadcastDataChange('runstats', uuid)
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
 * 运行日志时间线：运行行（runlog）+ 无法归属的错误行（errors 里 runId 落空 /
 * 无 runId 的记录）按时间倒序混排。运行期错误按 runId 挂到所属运行行上（不复制明细）。
 */
export async function listRunTimeline(): Promise<UserScriptRunLogRow[]> {
  const [log, errors] = await Promise.all([runtime.readRunLog(), listUserScriptErrors()])
  const runIds = new Set(log.map((r) => r.runId))
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
    ...log.map((r) => ({
      kind: 'run' as const,
      runId: r.runId,
      uuid: r.uuid,
      name: r.name,
      time: r.time,
      errors: byRun.get(r.runId) ?? [],
    })),
    ...loose.map((e) => ({ kind: 'error' as const, record: e })),
  ]
  return rows.sort((a, b) => (b.kind === 'run' ? b.time : b.record.time) - (a.kind === 'run' ? a.time : a.record.time))
}

/**
 * 清运行日志（读改写原子）。
 * @param uuid 缺省 = 清全部；字符串 = 只清该脚本的条目；null = no-op
 *   （日志条目必带 uuid，「未归属」只存在于错误日志，由 clearUserScriptErrors 管）。
 */
export function clearRunLog(uuid?: string | null): Promise<void> {
  if (uuid === null) return Promise.resolve()
  return runtime
    .mutateRunLog((log) => {
      if (uuid === undefined) return []
      const kept = log.filter((r) => r.uuid !== uuid)
      return kept.length === log.length ? null : kept // 无该脚本条目：不写回
    })
    .then((changed) => {
      if (changed) broadcastDataChange('runstats')
    })
}

/** 删除脚本时清掉它的运行统计与运行日志条目（与 clearGMValues / clearUserScriptErrors 同一条删除语义） */
export function clearRunStats(uuid: string): Promise<void> {
  return Promise.all([runtime.deleteStats(uuid), clearRunLog(uuid)]).then(() => {})
}
