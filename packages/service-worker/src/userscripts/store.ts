// 用户脚本的 SW 侧持久化（写出口汇聚层）。
//
// 项目数据（源码/配置/产物/enabled）的权威在 IndexedDB 状态库 duoling-state
// （读侧是 @duoling/shared 的 project-store 直连 IDB，写侧在包内 userstate/project-write）。
// 本文件管观测数据（duoling-runtime 库，见 runtime-db.ts —— 标签页存续 + 一根活动轴：
// 文档事件 / 记录开关 / 接口采样 / 运行条目 / 动作 / 错误）；GM 值存储（duoling-usdata 库）
// 在包内 gm-values.ts。
//
// 观测数据的读改写在 runtime-db 的同一事务内完成（天然原子），故这里不再需要
// chrome.storage 时代的进程内串行队列；「无变化不落盘」语义原样保留，广播只在实际
// 写入后发。环形裁剪与级联删除都在 runtime-db 内完成，本层只表达业务语义。
//
// 「一切观测只在开着活动记录的页上产生」这条口径的判据落在 recordRunStart（没有
// tabSessionId 直接不写）；错误侧由 runtime-db 从所属运行条继承页归属，存储层保证一致。
import { broadcastDataChange } from '@duoling/shared'
import {
  type RunEndReason,
  type ScriptProject,
  type UserScriptErrorLookup,
  type ScriptSummary,
  type UserScriptErrorRecord,
  type UserScriptRunEvent,
  type UserScriptRunLogEntry,
  type UserScriptRunLogRow,
} from '@duoling/shared'
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

// —— 错误记录（duoling-runtime 库 tab_events，kind = 'error'）——
//
// 运行期错误经 GM 包装转发到 onUserScriptMessage 后被收集；注册失败与依赖 / 资源抓取失败
// 在后台直接收集 —— 后三类与任何一页无关，落盘但不带页归属（见 runtime-db 的 appendErrorRow）。
// 环形保留最近 N 条，避免无限增长（上限定义在 types.ts，与实现同源）。
// 追加 / 裁剪 / 删除都在 runtime-db 的事务内原子完成，无需进程内队列串行。

/**
 * 追加一条错误（自动补 id；time 缺省用当前时间）。
 *
 * 页归属不在这里定：有 runId 的（运行期 / 桥错误）由 runtime-db 从所属运行条继承
 * tabSessionId，没有的（注册失败 / 依赖抓取失败）恒无归属 —— 于是它们只落盘、
 * 不出现在任何一页的面板里。
 */
export async function appendUserScriptError(
  // time 由本函数兜底（rec.time || Date.now()），故对调用方可选
  rec: Omit<UserScriptErrorRecord, 'id' | 'time'> & { id?: string; time?: number },
): Promise<void> {
  await runtime.appendErrorRow({
    ...rec,
    id: rec.id || crypto.randomUUID(),
    time: rec.time || Date.now(),
  })
  // 广播埋在这里而不是各个调用点：错误有 4 个上报入口（background 的注册兜底、
  // engine 两处、dl-bridge 的脚本消息转发），这里是唯一汇合点。
  // 崩溃风暴的高频 append 由广播侧的合并窗口（100ms）兜住，前端不会被打爆。
  broadcastDataChange('error', rec.uuid ?? undefined)
}

/** 列出全部错误（最新在前） */
export async function listUserScriptErrors(): Promise<UserScriptErrorRecord[]> {
  return (await runtime.listErrors()).slice().reverse()
}

/**
 * 清空错误日志。
 *
 * @param uuid 缺省 = 清全部；字符串 = 只清该脚本的记录；**null = 只清「无脚本上下文」记录**
 *   （uuid 为 null 的那些：注册失败 —— 它发生在任何脚本上下文之前）。
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
// 查询结果的形状归契约包（AI 工具与前缀检索共用），此处 re-export 维持既有路径。
export type { UserScriptErrorLookup }

export async function findUserScriptError(id: string): Promise<UserScriptErrorLookup> {
  // 走 by_errId 索引按前缀取，不扫全表：合表后表里还躺着接口采样（条数无上限），
  // 「全量读回来再筛」在真实数据量下不可行（见 runtime-db 的 findErrorsByIdPrefix）
  const hits = await runtime.findErrorsByIdPrefix(id)
  if (!hits.length) return { found: false, reason: 'not-found' }
  const exact = hits.find((e) => e.id === id)
  if (exact) return { found: true, record: exact }
  // 前缀下限 8 位：工作台展示的就是前 8 位，太短碰撞概率失控（精确 id 已在上面判过）
  if (id.length < 8) return { found: false, reason: 'not-found' }
  if (hits.length > 1) return { found: false, reason: 'ambiguous' }
  return { found: true, record: hits[0]! }
}

// —— 运行条目 / 动作（tab_events 里 kind = 'run' / 'act' 的行）——
//
// 运行条 = 一条一次运行；动作 = 一条一个动作（按 runId 索引，读整根轴时一并带出）。
// 「无变化不落盘」：补播去重 / 已结束条目重复回写都直接跳过，不写也不广播。

/**
 * 登记一次运行开始（dl-bridge 收到 __dlRunStart 广播时调用）。
 *
 * **没有 tabSessionId 就不记**：一切观测只在「这一页开着活动记录」时产生，而运行条是动作与
 * 错误的归属锚，无归属的运行没有意义（判据统一见 runtime-db 文件头）。判据落在这一层而不是
 * 各调用方：调用点有两处（首次广播与 load 补救补播），漏一处就漏一处观测。
 *
 * 同一 runId 的重复广播（engine 的 load 补救补播）由 runtime-db 按「该 runId 是否已有运行条」
 * 去重、整体跳过 —— 补播若重写运行条会抹掉两次广播之间已收集的动作计数。
 *
 * @param extra 运行所在页面、注入时的源码版本与所在标签页的存续 id（见 UserScriptRunLogEntry）
 */
export function recordRunStart(
  uuid: string,
  runId: string,
  name?: string,
  extra?: { url?: string; savedAt?: number; tabSessionId?: string },
): Promise<void> {
  const tabSessionId = extra?.tabSessionId
  if (!tabSessionId) return Promise.resolve()
  const entry: UserScriptRunLogEntry = {
    runId,
    uuid,
    // name 快照由调用方传（dl-bridge 手上有注册表）；没传就留空，UI 回退短 uuid
    name: name ?? '',
    time: Date.now(),
    tabSessionId,
    ...(extra?.url != null ? { url: extra.url } : {}),
    ...(extra?.savedAt != null ? { savedAt: extra.savedAt } : {}),
  }
  return runtime.appendRun(entry).then((recorded) => {
    // 「活动历史」面板靠这条广播实时回拉（合并窗口防导航风暴）
    if (recorded) broadcastDataChange('runlog', uuid)
  })
}

/**
 * 追加一条动作（dl-bridge 的 dispatch 采集后调用，见 UserScriptRunEvent）。
 *
 * 落进所属运行条的同一页（tabSessionId 由 runtime-db 从运行条继承）；找不到所属运行条
 * （已被环形挤掉、或该次运行压根没登记）即 no-op —— 动作是观察数据，不值得为它补造一条
 * 运行记录。到 RUN_EVENT_MAX 后不再落盘动作本体，只涨计数（读侧据此说明「已省略」）。
 */
export function recordRunEvent(uuid: string, runId: string, event: UserScriptRunEvent): Promise<void> {
  return runtime.appendAct(runId, event).then((written) => {
    // 到上限后不再有新动作落盘，也就不必再让面板白回拉一次
    if (written) broadcastDataChange('runlog', uuid)
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
    if (changed) broadcastDataChange('runlog')
  })
}

/**
 * 运行时间线（消费方是 AI 的 run_log_read）：运行条（tab_events 里 kind = 'run'）+
 * 与本次读取的运行集对不上的错误行（无 runId 的注册 / 依赖抓取失败，或该 runId 的运行
 * 已滑出环形）按时间倒序混排。运行期错误按 runId 挂到所属运行条上（不复制明细）。
 *
 * **不带动作**：动作跟着运行数全量读会线性膨胀（500 条运行 × 上限 1000 条），运行条只带
 * eventCount，要看某次运行干了什么再经 listRunEvents 按 runId 拉。
 *
 * 活动历史面板不走这条 —— 它按页读整根轴（见 runtime-db 的 listTabTimeline）。
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
 * 清运行条目（各自的动作一并级联删除，在 runtime-db 内同一事务完成）。
 * @param uuid 缺省 = 清全部；字符串 = 只清该脚本的条目；null = no-op
 *   （运行条必带 uuid，「未归属」只存在于错误日志，由 clearUserScriptErrors 管）。
 */
export function clearRunLog(uuid?: string | null): Promise<void> {
  if (uuid === null) return Promise.resolve()
  return runtime.clearRuns(uuid ?? undefined).then((changed) => {
    if (changed) broadcastDataChange('runlog')
  })
}

/**
 * 「活动历史」删掉某一页的全部活动 —— 存续行 + 它在 tab_events 上的每一行（文档事件 /
 * 记录开关 / 接口采样 / 运行条目 / 动作 / 错误，六类一起走）。
 *
 * 一起删是刻意的：面板展示的是它们的合成。只删存续行，这一页会以「表里已查不到」的残影
 * 留在列表里（它的轴行还在）；六类同表 + 同归属键，故整件事在 runtime-db 内一条索引删、
 * 一个事务完成（见 runtime-db 的 clearTabActivity），不会留下「行没了、轴行还在」的中间态。
 *
 * **只清已记录的内容**，不动门禁里的进行中会话。
 */
export async function deleteTabActivity(tabSessionId: string): Promise<void> {
  if (!(await runtime.clearTabActivity([tabSessionId]))) return
  // 整根轴一趟清掉，运行线与错误两个消费域都要回拉（重复通知只是让消费方多读一次）
  broadcastDataChange('runlog')
  broadcastDataChange('error')
  // 活动历史还要重算左栏（少了一行）；不带 uuid —— 整根轴都没了，增量游标无从续起
  broadcastDataChange('tabActivity')
}

/**
 * 「活动历史」清空全部 —— 存续行 + tab_events 上的整根轴（含无归属的错误行）。
 *
 * **不动门禁**：正在录的那一页照常录，清历史不该把它停掉。
 */
export async function clearAllTabActivity(): Promise<void> {
  if (!(await runtime.clearTabActivity())) return
  broadcastDataChange('runlog')
  broadcastDataChange('error')
  broadcastDataChange('tabActivity')
}
