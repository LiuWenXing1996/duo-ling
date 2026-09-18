// 用户脚本的 chrome.storage 侧持久化。
//
// 项目数据（源码/配置/产物/enabled）的权威在 IndexedDB 状态库 duoling-state
// （读侧 lib/userscripts/project-store.ts，写侧 project-write.ts，均不碰 chrome API）。
// 本文件剩三类：DL.store 值（us:gm:*）、错误日志（us:errors）、运行统计（us:run-stats:*）。
//
// 为什么这三类不一起迁：写入方是**注入页面里的用户脚本**（不受我们控制、可能被高频调用、
// 且脚本崩溃时才上报错误），且它们不参与「脚本是什么」的判定——转 offscreen 只会多一跳、
// 在最脆弱的时刻更容易丢（见 src/lib/userscripts/state-db.ts）。
import {
  GM_KEY_PREFIX,
  ERRORS_KEY,
  ERROR_LOG_MAX,
  RUN_STATS_KEY_PREFIX,
  gmKey,
  runStatsKey,
  type ScriptProject,
  type ScriptSummary,
  type UserScriptErrorRecord,
  type UserScriptRunStats,
} from './types'
import { broadcastDataChange } from '../data-broadcast'

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
    // 文件数来自状态库缓存（源码在 duoling-fs，SW 读不到，故落盘时算好存于此）
    fileCount: p.fileCount ?? 0,
    updatedAt: p.updatedAt,
    // 构建终态：新记录显式存于 buildOk；旧记录（加字段前落盘）按产物有无兜底推导
    buildOk: p.buildOk ?? p.bundle !== undefined,
    ...(p.lastBuildAt !== undefined ? { lastBuildAt: p.lastBuildAt } : {}),
  }))
  return [...projectSummaries].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || b.updatedAt - a.updatedAt,
  )
}

// —— DL.store 值存储（键空间 us:gm:<uuid>:<key> 沿用）——

export async function getGMValue(uuid: string, key: string): Promise<unknown> {
  const store = await chrome.storage.local.get(gmKey(uuid, key))
  return store[gmKey(uuid, key)]
}

export async function setGMValue(uuid: string, key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [gmKey(uuid, key)]: value })
}

export async function deleteGMValue(uuid: string, key: string): Promise<void> {
  await chrome.storage.local.remove(gmKey(uuid, key))
}

/** 列出某脚本存过的全部键 */
export async function listGMKeys(uuid: string): Promise<string[]> {
  const all = await chrome.storage.local.get()
  const prefix = GM_KEY_PREFIX + uuid + ':'
  return Object.keys(all)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
}

/** 清空某脚本的全部 DL.store 值 */
export async function clearGMValues(uuid: string): Promise<void> {
  const all = await chrome.storage.local.get()
  const prefix = GM_KEY_PREFIX + uuid + ':'
  const keys = Object.keys(all).filter((k) => k.startsWith(prefix))
  if (keys.length) await chrome.storage.local.remove(keys)
}

// —— 错误日志（错误面板）——
//
// 运行期错误经 DL 包装转发到 onUserScriptMessage 后被收集；注册/桥失败在后台直接收集。
// 环形保留最近 N 条，避免无限增长（上限定义在 types.ts，供 UI 文案同源引用）
const MAX_ERRORS = ERROR_LOG_MAX

// us:errors 是「读全量 → 改 → 写回整块」的 RMW，chrome.storage.local 没有原子写。
// 脚本崩溃风暴时多个 append 并发执行会互相覆盖（lost update），必须按 key 串行化。
// 进程内 promise 队列即可：写入方（用户脚本消息转发 / 后台兜底收集）都在本 SW 进程内。
// clear 也排进同一队列——否则清空可能被排在前面的 append 用旧数据写回覆盖。
let errorOpsQueue: Promise<unknown> = Promise.resolve()

function enqueueErrorOp<T>(op: () => Promise<T>): Promise<T> {
  const run = errorOpsQueue.then(op, op)
  // 队列自身永不 reject，否则后续操作全部中断；错误由调用方拿到的 run 承接
  errorOpsQueue = run.catch(() => {})
  return run
}

/** 追加一条错误（自动补 id；time 缺省用当前时间）。并发安全：读改写按队列串行。 */
export async function appendUserScriptError(
  // time 由本函数兜底（rec.time || Date.now()），故对调用方可选
  rec: Omit<UserScriptErrorRecord, 'id' | 'time'> & { id?: string; time?: number },
): Promise<void> {
  return enqueueErrorOp(async () => {
    const existing =
      ((await chrome.storage.local.get(ERRORS_KEY))[ERRORS_KEY] as UserScriptErrorRecord[] | undefined) ?? []
    const next = existing.slice(-(MAX_ERRORS - 1))
    next.push({ ...rec, id: rec.id || crypto.randomUUID(), time: rec.time || Date.now() })
    await chrome.storage.local.set({ [ERRORS_KEY]: next })
    // 广播埋在这里而不是各个调用点：错误有 4 个上报入口（background 的注册兜底、
    // engine 两处、dl-bridge 的脚本消息转发），这里是唯一汇合点。
    // 崩溃风暴的高频 append 由广播侧的合并窗口（100ms）兜住，前端不会被打爆。
    broadcastDataChange('error', rec.uuid ?? undefined)
    // 运行期错误同步计入该脚本的「最近一次运行」错误数（独立队列，失败不影响错误记录本身）
    void noteRunError(rec.uuid ?? null, typeof rec.runId === 'string' ? rec.runId : null).catch(() => {})
  })
}

/** 列出全部错误（最新在前） */
export async function listUserScriptErrors(): Promise<UserScriptErrorRecord[]> {
  const r = (await chrome.storage.local.get(ERRORS_KEY))[ERRORS_KEY] as UserScriptErrorRecord[] | undefined
  return (r ?? []).slice().reverse()
}

/**
 * 清空错误日志（与 append 同队列串行，避免清空被并发写回覆盖）。
 *
 * @param uuid 缺省 = 清全部；字符串 = 只清该脚本的记录；**null = 只清「未归属」记录**
 *   （uuid 为 null 的那些：注册失败无脚本上下文、部分桥错误）。
 *   三态各自独立，故判定用 `=== undefined` 而非 falsy —— `null` 是有效目标，不是「没传」。
 */
export async function clearUserScriptErrors(uuid?: string | null): Promise<void> {
  return enqueueErrorOp(async () => {
    if (uuid === undefined) {
      await chrome.storage.local.remove(ERRORS_KEY)
      broadcastDataChange('error') // 全量清空
      return
    }
    const existing =
      ((await chrome.storage.local.get(ERRORS_KEY))[ERRORS_KEY] as UserScriptErrorRecord[] | undefined) ?? []
    const kept = existing.filter((e) => e.uuid !== uuid)
    // 没有该脚本的记录就不写回：RMW 的「无变化不落盘」语义，避免白写一次全量
    if (kept.length === existing.length) return
    if (!kept.length) {
      await chrome.storage.local.remove(ERRORS_KEY)
    } else {
      await chrome.storage.local.set({ [ERRORS_KEY]: kept })
    }
    // null（未归属）没有单条 uuid 可指，按全量通知
    broadcastDataChange('error', uuid ?? undefined)
  })
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

// —— 运行统计（us:run-stats:<uuid>，按脚本聚合计数）——
//
// 防写放大：不逐条落环形日志，每脚本只维护一个小计数器对象（总次数 / 最后运行时间 /
// 最近一次运行的错误数），一次页面加载只付一次小对象读改写。
// RMW 与错误日志同款风险（chrome.storage.local 无原子写）：写方都在本 SW 进程内，
// 按独立队列串行化；与错误队列分开——统计写失败不能拖住错误记录的落盘，反之亦然。
// 「无变化不落盘」：补播去重 / 旧运行迟到错误两类情况直接 return，不写回。
let statsOpsQueue: Promise<unknown> = Promise.resolve()

function enqueueStatsOp<T>(op: () => Promise<T>): Promise<T> {
  const run = statsOpsQueue.then(op, op)
  // 队列自身永不 reject，否则后续操作全部中断；错误由调用方拿到的 run 承接
  statsOpsQueue = run.catch(() => {})
  return run
}

/**
 * 登记一次运行开始（dl-bridge 收到 __dlRunStart 广播时调用，有无 tabId 都记）。
 * 同一 runId 的重复广播（engine 的 load 补救补播）按 lastRunId 去重，是 no-op——
 * 补播若重置 lastRunErrors 会抹掉两次广播之间已上报的错误，故去重必须整体跳过。
 */
export function recordRunStart(uuid: string, runId: string): Promise<void> {
  return enqueueStatsOp(async () => {
    const key = runStatsKey(uuid)
    const cur = (await chrome.storage.local.get(key))[key] as UserScriptRunStats | undefined
    if (cur?.lastRunId === runId) return // 同一次运行的补播：不重复计数、不清错误数
    const next: UserScriptRunStats = {
      totalRuns: (cur?.totalRuns ?? 0) + 1,
      lastRunAt: Date.now(),
      lastRunId: runId,
      lastRunErrors: 0,
    }
    await chrome.storage.local.set({ [key]: next })
    // 管理页的运行统计列靠这条广播实时回拉（合并窗口防导航风暴）
    broadcastDataChange('runstats', uuid)
  })
}

/**
 * 运行期错误计入「最近一次运行」的错误数（appendUserScriptError 的汇合点调用）。
 * 仅当错误带 uuid + runId 且 runId 与最近一次运行一致才计数——旧运行的迟到错误、
 * register/bridge 类无运行上下文的错误都不算（后者不是「脚本运行挂了」）。
 */
export function noteRunError(uuid: string | null, runId: string | null): Promise<void> {
  if (!uuid || !runId) return Promise.resolve()
  return enqueueStatsOp(async () => {
    const key = runStatsKey(uuid)
    const cur = (await chrome.storage.local.get(key))[key] as UserScriptRunStats | undefined
    // 从未登记过运行（runstart 丢失 / 尚未处理）或错误属于更早的运行：不计
    if (!cur || cur.lastRunId !== runId) return
    const next: UserScriptRunStats = { ...cur, lastRunErrors: (cur.lastRunErrors ?? 0) + 1 }
    await chrome.storage.local.set({ [key]: next })
    broadcastDataChange('runstats', uuid)
  })
}

/** 给列表摘要挂上运行统计（无统计的脚本保持缺省，UI 据此不渲染该列） */
export async function withRunStats(summaries: ScriptSummary[]): Promise<ScriptSummary[]> {
  if (!summaries.length) return summaries
  const all = await chrome.storage.local.get()
  const byUuid = new Map<string, UserScriptRunStats>()
  for (const s of summaries) {
    const st = all[runStatsKey(s.uuid)] as UserScriptRunStats | undefined
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

/** 删除脚本时清掉它的运行统计（与 clearGMValues / clearUserScriptErrors 同一条删除语义） */
export async function clearRunStats(uuid: string): Promise<void> {
  await chrome.storage.local.remove(runStatsKey(uuid))
}
