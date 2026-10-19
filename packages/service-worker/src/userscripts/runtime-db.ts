// 用户脚本「观测数据」的底层存储：独立 IndexedDB 库 duoling-runtime（SW 独占写）。
//
// 两张 store 装下全部：
//   · tab_sessions —— 标签页存续（一行一个「被观察到的页」，keyPath tabSessionId）
//   · tab_events   —— 这一页的活动轴（一行一个时间轴节点，自增主键），六类行靠 kind 判别
//
// 合表理由、判据统一、主键与复合索引、环形裁剪、级联删除、迁移策略（升级即清库）与
// 单写方约定等设计决策见 ARCHITECTURE.md「存储」节的观测数据库。

import {
  ACT_TAB_KIND,
  ERR_TAB_KIND,
  ERROR_LOG_MAX,
  RUN_EVENT_MAX,
  RUN_LOG_MAX,
  RUN_TAB_KIND,
  TAB_SESSION_MAX,
  type RunEndReason,
  type TabEventRecord,
  type TabSessionRecord,
  type TabTimeline,
  type UserScriptErrorRecord,
  type UserScriptRunEvent,
  type UserScriptRunLogEntry,
} from '@duoling/shared'
import {
  NET_TAB_KIND,
  getRuntimeDb,
  idbRequest as request,
  idbRunTx,
  RUNTIME_EV_BY_ERR as EV_BY_ERR,
  RUNTIME_EV_BY_KIND as EV_BY_KIND,
  RUNTIME_EV_BY_KIND_RUN as EV_BY_KIND_RUN,
  RUNTIME_EV_BY_SESSION_SEQ as EV_BY_SESSION_SEQ,
  RUNTIME_TAB_EVENTS_STORE as TAB_EVENTS_STORE,
  RUNTIME_TAB_SESSIONS_STORE as TAB_SESSIONS_STORE,
  RUNTIME_TABS_BY_SEEN as TABS_BY_SEEN,
  RUNTIME_TABS_BY_TAB as TABS_BY_TAB,
  type NetCaptureRecord,
} from '@duoling/shared'

/**
 * 复合索引 by_kind_run 的键：`[kind, runId]`（找运行条一击、拉动作互不串；无 runId 的行不进索引）。
 * 为什么不用单键 runId 见 docs/adr/0015-runtime-db-composite-indexes.md。
 */
function kindRunRange(kind: string, runId: string): IDBKeyRange {
  return IDBKeyRange.only([kind, runId])
}

/**
 * 某一页在轴上的键区间：`[页, sinceId]` 到 `[页, 上界]`，**下界开**（严格大于 `sinceId`）。
 *
 * 开下界是游标语义的要求：`sinceId` 传的是上一批的 `maxId`，那一行上一批已经读回来了，
 * 下界闭合会让每一批增量都把它再回一遍 —— 面板看着像是「最后一条重复出现」。
 * `id` 是自增正整数（从 1 起），故缺省 0 与开下界不冲突：它等价于「从第一条起」。
 * 上界用 `MAX_SAFE_INTEGER` 而不是空数组那种技巧，是因为 id 的取值范围本来就确定（自增整数）。
 */
function sessionRange(tabSessionId: string, sinceId = 0): IDBKeyRange {
  return IDBKeyRange.bound([tabSessionId, sinceId], [tabSessionId, Number.MAX_SAFE_INTEGER], true)
}

/** tab_events 里的运行条目：条目本体 + 判别键（主键 id 读回来才有，写侧不设） */
interface RunRow extends UserScriptRunLogEntry {
  id?: number
  kind: typeof RUN_TAB_KIND
}

/**
 * tab_events 里的动作行。
 *
 * 动作本体嵌在 `event` 下而不是平铺：它自带 `kind`（动作族名，如 fetch），与同表的行判别键
 * 同名，平铺会撞。`tabSessionId` 从所属运行条继承（动作必然发生在某次运行之中）。
 */
interface ActRow {
  id?: number
  kind: typeof ACT_TAB_KIND
  tabSessionId?: string
  runId: string
  event: UserScriptRunEvent
}

/**
 * tab_events 里的错误行。
 *
 * 业务 id 存 `errId` —— 主键 `id` 已被自增号占用（同表所有行共用），两个 id 不能同名。
 */
interface ErrRow {
  id?: number
  kind: typeof ERR_TAB_KIND
  errId: string
  uuid: string | null
  name: string
  phase: UserScriptErrorRecord['phase']
  message: string
  stack?: string
  url?: string
  time: number
  runId?: string | null
  tabSessionId?: string
}

/** tab_events 里的接口采样：采样本体 + 判别键（判别键只在存储层存在，读侧剥掉） */
interface TabCaptureRow extends NetCaptureRecord {
  id?: number
  kind: typeof NET_TAB_KIND
}

/** tab_events 里所有行的联合（读侧按 kind 收窄） */
type TabTimelineRow = TabEventRecord | TabCaptureRow | RunRow | ActRow | ErrRow

/**
 * tab_sessions 的记录体 = 公开类型 + 一个内部字段。
 * `firstSeenAt` 只用于裁剪排序（「谁先登记的」），不是给用户看的时刻——公开类型里不含它，
 * 免得读侧误以为它是「标签页出生时刻」（那得看 createdAt）。
 */
interface TabSessionRow extends TabSessionRecord {
  firstSeenAt: number
}

function runTx<T>(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  return idbRunTx(getRuntimeDb(), storeNames, mode, run)
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

/** 剥掉存储层的判别键与主键，交回公开类型 */
function toRunEntry({ kind: _discriminator, id: _rowId, ...entry }: RunRow): UserScriptRunLogEntry {
  return entry
}

/** 剥掉判别键与主键，并把存储层的 errId 换回公开的 id */
function toErrorRecord({
  kind: _discriminator,
  id: _rowId,
  errId,
  ...rest
}: ErrRow): UserScriptErrorRecord {
  return { ...rest, id: errId }
}

/**
 * 剥掉存储层的判别键，交回协议类型。
 *
 * `id` **留着**（区别于运行条 / 错误行那两个同名剥法）：采样没有自带业务 id，行身份就是
 * 自增主键 —— 面板的时间线列表 key 与展开态 key 都读 `rec.id`，剥掉会退化成「全是 undefined」
 * 的重复 key。
 */
function toCapture({ kind: _discriminator, ...rec }: TabCaptureRow): NetCaptureRecord {
  return rec
}

/** 文档事件与记录开关的判别（这四类没有额外载荷，读侧当纯文本行渲染） */
function isSessionEventRow(row: TabTimelineRow): row is TabEventRecord {
  return (
    row.kind === 'reload' ||
    row.kind === 'url' ||
    row.kind === 'recordOn' ||
    row.kind === 'recordOff'
  )
}

// —— 运行条目（tab_events 里 kind = 'run' 的行）——

/**
 * 登记一次运行开始（写运行条），并按落盘序裁到 RUN_LOG_MAX 条。
 *
 * 同一 runId 的重复广播（engine 的 load 补救补播）按「该 runId 是否已有运行条」去重、整体
 * 跳过 —— 补播若重写运行条会抹掉两次广播之间已上报的动作计数。
 *
 * 挤出最旧的运行条时**连带删它的动作行**（同 runId，同事务）：动作是「这次运行干了什么」，
 * 运行条没了就成了读不出来的孤儿。错误行不跟着走（它有自己的环形，留在轴上仍按页可见）。
 *
 * @returns 是否真的登记了（false = 补播去重，调用方不广播）
 */
export async function appendRun(entry: UserScriptRunLogEntry): Promise<boolean> {
  return runTx(TAB_EVENTS_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(TAB_EVENTS_STORE)
    const same = await request<RunRow[]>(
      store.index(EV_BY_KIND_RUN).getAll(kindRunRange(RUN_TAB_KIND, entry.runId)),
    )
    if ((same ?? []).length > 0) {
      await txDone(tx, '写入运行条目')
      return false
    }
    store.add({ ...entry, kind: RUN_TAB_KIND } satisfies RunRow)
    const running = await request<number>(store.index(EV_BY_KIND).count(RUN_TAB_KIND))
    const excess = (running ?? 0) - RUN_LOG_MAX
    if (excess > 0) {
      const victims: string[] = []
      await eachCursor(
        store.index(EV_BY_KIND).openCursor(IDBKeyRange.only(RUN_TAB_KIND)),
        excess,
        (cursor) => {
          victims.push((cursor.value as RunRow).runId)
          cursor.delete()
        },
      )
      for (const runId of victims) await deleteActsOf(store, runId)
    }
    await txDone(tx, '写入运行条目')
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
  return runTx(TAB_EVENTS_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(TAB_EVENTS_STORE)
    let touched = false
    for (const runId of runIds) {
      const run = await request<RunRow | undefined>(
        store.index(EV_BY_KIND_RUN).get(kindRunRange(RUN_TAB_KIND, runId)),
      )
      if (!run || run.endedAt != null) continue
      store.put({ ...run, endedAt, endReason: reason } satisfies RunRow)
      touched = true
    }
    await txDone(tx, '回写运行结束')
    return touched
  })
}

/** 运行条目全量（按落盘序 = 时间序）。消费方：运行时间线 / 按页聚合计数 */
export async function listRuns(): Promise<UserScriptRunLogEntry[]> {
  const rows = await runTx(TAB_EVENTS_STORE, 'readonly', async (tx) =>
    request<RunRow[]>(tx.objectStore(TAB_EVENTS_STORE).index(EV_BY_KIND).getAll(RUN_TAB_KIND)),
  )
  return (rows ?? []).map(toRunEntry)
}

/**
 * 清运行条目：不带 uuid = 清全部；带 uuid = 只清该脚本的。两者都**级联删掉它们的动作行**。
 *
 * 错误不在此清 —— 它由 clearUserScriptErrors 管（语义各归各的：这里管「跑过什么」，
 * 那里管「报了什么错」）。
 *
 * @returns 是否真有条目被删（调用方据此决定要不要广播）
 */
export async function clearRuns(uuid?: string): Promise<boolean> {
  return runTx(TAB_EVENTS_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(TAB_EVENTS_STORE)
    const runIds: string[] = []
    await eachCursor(
      store.index(EV_BY_KIND).openCursor(IDBKeyRange.only(RUN_TAB_KIND)),
      Infinity,
      (cursor) => {
        const run = cursor.value as RunRow
        if (uuid !== undefined && run.uuid !== uuid) return
        runIds.push(run.runId)
        cursor.delete()
      },
    )
    let acts = 0
    for (const runId of runIds) acts += await deleteActsOf(store, runId)
    await txDone(tx, '清空运行条目')
    return runIds.length > 0 || acts > 0
  })
}

// —— 运行内动作（tab_events 里 kind = 'act' 的行）——

/**
 * 追加一条动作，同事务内把所属运行条目的 eventCount 加一。
 *
 * 找不到所属运行条（已被环形挤掉 / 压根没登记）即不写——动作是观察数据，
 * 不值得为它补造一条运行记录。达到 RUN_EVENT_MAX 后不再落盘动作，只继续涨计数
 * （读侧靠「计数 > 实存条数」看出被截断）。
 *
 * tabSessionId 从运行条继承（同事务里已经读到了它），故动作行恒与运行条同一页归属。
 *
 * 找运行条走 `by_kind_run` 的复合键（`['run', runId]`）—— **一次精确取**，不把整次运行已经
 * 落下的上千条动作读回来（这是本函数的热路径，逐条追加的代价必须是 O(log n) 而非 O(n)）。
 *
 * @returns 是否真的写入了动作（false = 已达上限或无主，调用方不必广播）
 */
export async function appendAct(runId: string, event: UserScriptRunEvent): Promise<boolean> {
  return runTx(TAB_EVENTS_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(TAB_EVENTS_STORE)
    const run = await request<RunRow | undefined>(
      store.index(EV_BY_KIND_RUN).get(kindRunRange(RUN_TAB_KIND, runId)),
    )
    if (!run) {
      await txDone(tx, '写入运行动作')
      return false
    }
    const received = run.eventCount ?? 0
    const written = received < RUN_EVENT_MAX
    if (written) {
      store.add({
        kind: ACT_TAB_KIND,
        runId,
        event,
        ...(run.tabSessionId ? { tabSessionId: run.tabSessionId } : {}),
      } satisfies ActRow)
    }
    store.put({ ...run, eventCount: received + 1 } satisfies RunRow)
    await txDone(tx, '写入运行动作')
    return written
  })
}

/** 某次运行的全部动作（按发生先后升序：索引内同键按主键序 = 插入序 = 时间序） */
export async function listRunEvents(runId: string): Promise<UserScriptRunEvent[]> {
  const rows = await runTx(TAB_EVENTS_STORE, 'readonly', async (tx) =>
    request<TabTimelineRow[]>(
      tx
        .objectStore(TAB_EVENTS_STORE)
        .index(EV_BY_KIND_RUN)
        .getAll(kindRunRange(ACT_TAB_KIND, runId)),
    ),
  )
  const out: UserScriptRunEvent[] = []
  for (const row of rows ?? []) {
    if (row.kind === ACT_TAB_KIND) out.push(row.event)
  }
  return out
}

/** 删掉某次运行的全部动作行（级联删除的落点）。@returns 删掉的条数 */
function deleteActsOf(store: IDBObjectStore, runId: string): Promise<number> {
  let removed = 0
  // 键是 `['act', runId]`：命中的必然是动作行（运行条是 `['run', runId]`，错误行不随运行条走）
  return eachCursor(
    store.index(EV_BY_KIND_RUN).openCursor(kindRunRange(ACT_TAB_KIND, runId)),
    Infinity,
    (cursor) => {
      cursor.delete()
      removed += 1
    },
  ).then(() => removed)
}

// —— 错误记录（tab_events 里 kind = 'error' 的行）——

/**
 * 追加一条错误，并按落盘序裁到 ERROR_LOG_MAX 条（追加与裁剪同一事务，崩溃风暴下的并发
 * append 不会把上限冲破）。
 *
 * 无归属的错误（注册失败 / 依赖抓取失败）不带 tabSessionId，故不进 by_session_seq 索引，
 * 按页查询天然查不到它们 —— 这正是「只落盘、不出现在面板里」的实现方式，写侧不需要过滤。
 */
export async function appendErrorRow(rec: UserScriptErrorRecord): Promise<void> {
  await runTx(TAB_EVENTS_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(TAB_EVENTS_STORE)
    // 页归属：运行期 / 桥错误从所属运行条继承（同事务里顺带读到）；注册失败与依赖抓取失败
    // 没有 runId，恒无归属 —— 那正是「只落盘、不进面板」的实现方式
    let tabSessionId = rec.tabSessionId
    if (!tabSessionId && rec.runId) {
      const run = await request<RunRow | undefined>(
        store.index(EV_BY_KIND_RUN).get(kindRunRange(RUN_TAB_KIND, rec.runId)),
      )
      tabSessionId = run?.tabSessionId
    }
    const { id: errId, ...rest } = rec
    store.add({
      ...rest,
      ...(tabSessionId ? { tabSessionId } : {}),
      errId,
      kind: ERR_TAB_KIND,
    } satisfies ErrRow)
    const total = await request<number>(store.index(EV_BY_KIND).count(ERR_TAB_KIND))
    const excess = (total ?? 0) - ERROR_LOG_MAX
    if (excess > 0) {
      await eachCursor(
        store.index(EV_BY_KIND).openCursor(IDBKeyRange.only(ERR_TAB_KIND)),
        excess,
        (cursor) => cursor.delete(),
      )
    }
    await txDone(tx, '写入错误记录')
  })
}

/** 错误全量（按落盘序 = 时间正序，最新在尾；最新在前的展示由调用方反转） */
export async function listErrors(): Promise<UserScriptErrorRecord[]> {
  const rows = await runTx(TAB_EVENTS_STORE, 'readonly', async (tx) =>
    request<ErrRow[]>(tx.objectStore(TAB_EVENTS_STORE).index(EV_BY_KIND).getAll(ERR_TAB_KIND)),
  )
  return (rows ?? []).map(toErrorRecord)
}

/**
 * 按条件删错误。@returns 是否有记录被删（无变化不落盘，调用方据此决定要不要广播）
 */
export async function deleteErrors(
  where: (rec: UserScriptErrorRecord) => boolean,
): Promise<boolean> {
  return runTx(TAB_EVENTS_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(TAB_EVENTS_STORE)
    let removed = 0
    await eachCursor(
      store.index(EV_BY_KIND).openCursor(IDBKeyRange.only(ERR_TAB_KIND)),
      Infinity,
      (cursor) => {
        if (!where(toErrorRecord(cursor.value as ErrRow))) return
        cursor.delete()
        removed += 1
      },
    )
    await txDone(tx, '删除错误记录')
    return removed > 0
  })
}

/**
 * 按错误 id 查（精确 id 或前缀）：**走 by_errId 索引**，不扫全表。
 *
 * 为什么必须走索引：合表后 tab_events 里还躺着接口采样（单条数 KB、条数无上限），
 * 「把全表读回来再筛」在真实数据量下不可接受。
 *
 * 前缀匹配用 `IDBKeyRange.bound(prefix, prefix + '\uffff')`（\uffff 大于任何 BMP 字符，
 * uuid 只含 ASCII，够用）。调用方负责判断命中是否唯一（见 store.findUserScriptError）。
 */
export async function findErrorsByIdPrefix(idOrPrefix: string): Promise<UserScriptErrorRecord[]> {
  const rows = await runTx(TAB_EVENTS_STORE, 'readonly', async (tx) =>
    request<ErrRow[]>(
      tx
        .objectStore(TAB_EVENTS_STORE)
        .index(EV_BY_ERR)
        .getAll(IDBKeyRange.bound(idOrPrefix, `${idOrPrefix}\uffff`)),
    ),
  )
  return (rows ?? []).map(toErrorRecord)
}

// —— 标签页存续（tab_sessions store，keyPath tabSessionId）——
//
// 这张表给 tabId 一个稳定替身：别的面引用 tabSessionId、不引用 tabId（理由见 TabSessionRecord）。
// 时刻一律「记得到就记」，故这里没有任何补造逻辑 —— 缺省的字段就是未知，读侧如实显示。

/**
 * 建一行（取号）。
 *
 * 只有一处会调它：用户给这一页打开活动记录（见 tab-sessions 的 setTabRecording，加上单测直调）。
 * 那不是标签页出生的时刻，故**不写 `createdAt`** —— 没看着它出生就是不知道。
 *
 * 开记录建行时顺手落一条「开始记录」事件（同事务）：这一页的时间线因此从「几时开始记的」起头。
 *
 * @returns 新行的 tabSessionId
 */
export async function mintTabSession(input: {
  tabId: number
  url?: string
  /** 建行即开启记录（popup 的开关走这条）；缺省 = 这行只作历史起点，不接着记（也就没有开始记录那一条） */
  recording?: boolean
}): Promise<string> {
  const tabSessionId = crypto.randomUUID()
  await runTx([TAB_SESSIONS_STORE, TAB_EVENTS_STORE], 'readwrite', async (tx) => {
    const store = tx.objectStore(TAB_SESSIONS_STORE)
    const existing = await request<number>(store.count())
    const now = Date.now()
    store.put({
      tabSessionId,
      tabId: input.tabId,
      ...(input.url ? { url: input.url } : {}),
      ...(input.recording ? { recording: true } : {}),
      firstSeenAt: now,
    } satisfies TabSessionRow)
    if (input.recording) {
      addTabEvent(tx.objectStore(TAB_EVENTS_STORE), {
        tabSessionId,
        kind: 'recordOn',
        time: now,
      })
    }
    const excess = existing + 1 - TAB_SESSION_MAX
    if (excess > 0) await trimEndedTabSessions(store, tx.objectStore(TAB_EVENTS_STORE), excess)
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
 * 打开 / 关掉这一页的活动记录（popup 的开关）。
 *
 * 只改还开着的那一行：行已结束说明这个 tabId 早已不是当初那页，改它就是改错人。
 * **关掉不删行** —— 历史留着，只是不再长出新记录。
 *
 * 关掉时把字段整个删掉而非写 false：缺省即「没开」，读侧（取号与概览）只有一条判据。
 *
 * 真发生了切换才落一条「开始记录」/「结束记录」（同事务）：状态与「几点开的记录」是一件事的
 * 两面，分两次写会留下「行说没在记、时间线却说刚开始记」这种自相矛盾的状态。
 *
 * @returns 是否真改到了（没这行、或本来就是这个值 → false，不落盘也不落事件）
 */
export async function setTabSessionRecording(tabId: number, recording: boolean): Promise<boolean> {
  return runTx([TAB_SESSIONS_STORE, TAB_EVENTS_STORE], 'readwrite', async (tx) => {
    const store = tx.objectStore(TAB_SESSIONS_STORE)
    const row = await openRowOf(store, tabId)
    if (!row || (row.recording === true) === recording) {
      await txDone(tx, '切换标签页记录')
      return false
    }
    const { recording: _wasOn, ...rest } = row
    store.put(recording ? { ...rest, recording: true } : rest)
    addTabEvent(tx.objectStore(TAB_EVENTS_STORE), {
      tabSessionId: row.tabSessionId,
      kind: recording ? 'recordOn' : 'recordOff',
      time: Date.now(),
    })
    await txDone(tx, '切换标签页记录')
    return true
  })
}

/**
 * 盖上关闭时刻（`tabs.onRemoved` 调）。表里没有这个标签页就什么都不做 —— 没登记过的标签页
 * 不需要一条幽灵行（它连出生时刻都没有，留着只会占位与占上限）。
 *
 * 关闭时还在记的，替它收个尾（落一条「结束记录」，时刻就是关闭时刻）；用户自己关掉开关的不补
 * —— 那一段已经收过尾，再补一条是同一段收两次。
 *
 * @returns 是否真有条目被改写（调用方据此决定要不要广播）
 */
export async function closeTabSession(tabId: number, closedAt: number): Promise<boolean> {
  return runTx([TAB_SESSIONS_STORE, TAB_EVENTS_STORE], 'readwrite', async (tx) => {
    const store = tx.objectStore(TAB_SESSIONS_STORE)
    const row = await openRowOf(store, tabId)
    if (!row) {
      await txDone(tx, '标记标签页关闭')
      return false
    }
    store.put({ ...row, ended: true, closedAt })
    if (row.recording === true) {
      addTabEvent(tx.objectStore(TAB_EVENTS_STORE), {
        tabSessionId: row.tabSessionId,
        kind: 'recordOff',
        time: closedAt,
      })
    }
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
 * 当时还在记的行同样补一条「结束记录」（记录确实终止了）；但那条事件**不带时刻** ——
 * 与 closedAt 留空同一口径：不知道上一次会话几点结束的，就不拿「现在」顶上。
 *
 * @returns 被盖章的行数
 */
export async function endOpenTabSessions(): Promise<number> {
  return runTx([TAB_SESSIONS_STORE, TAB_EVENTS_STORE], 'readwrite', async (tx) => {
    const store = tx.objectStore(TAB_SESSIONS_STORE)
    const events = tx.objectStore(TAB_EVENTS_STORE)
    let ended = 0
    const stillRecording: string[] = []
    // 用 cursor.update 就地改写：同事务内 put 同一主键会让游标重访该记录
    await eachCursor(store.openCursor(), Infinity, (cursor) => {
      const row = cursor.value as TabSessionRow
      if (row.ended === true) return
      cursor.update({ ...row, ended: true } satisfies TabSessionRow)
      if (row.recording === true) stillRecording.push(row.tabSessionId)
      ended += 1
    })
    // 收尾事件放在游标走完之后补：游标回调是同步的，逐条 await 塞不进去（同 appendRun 的 victims）
    for (const tabSessionId of stillRecording) {
      addTabEvent(events, { tabSessionId, kind: 'recordOff' })
    }
    await txDone(tx, '划断标签页存续')
    return ended
  })
}

/**
 * 对账：把「还开着、但它那个 tabId 已经不在」的行盖章结束。
 *
 * 为什么需要：标签页可能趁 SW 睡着时被关掉，`tabs.onRemoved` 的收尾要等 SW 下次醒来才补上；
 * 若它再没醒（用户就此收工），库里就留着一条 `recording: true` 且未结束的行 ——
 * 而 `hasRecordingTabSession()` 只看「未结束 + recording」，于是会一直为真：
 * 明明没人录了，录制件却全匹配地挂在每个站点上。故 SW 每次启动对一遍账。
 *
 * 与 `endOpenTabSessions` 的分工：那个在**浏览器启动**时把全部未结束行盖章（那时它们确实都死了，
 * 因为 tabId 是本次运行的流水号）；这个在 **SW 冷启动**时只盖「tabId 已不存在」的那些 ——
 * 冷启动时活着的行正是本会话还开着的页，不能碰。
 *
 * 时刻留空：这些行究竟几点关的没人知道，不拿「现在」冒充（与 endOpenTabSessions 同口径）。
 *
 * @returns 被盖章的行数
 */
export async function endDeadTabSessions(aliveTabIds: Set<number>): Promise<number> {
  return runTx([TAB_SESSIONS_STORE, TAB_EVENTS_STORE], 'readwrite', async (tx) => {
    const store = tx.objectStore(TAB_SESSIONS_STORE)
    const events = tx.objectStore(TAB_EVENTS_STORE)
    let ended = 0
    const stillRecording: string[] = []
    // 用 cursor.update 就地改写：同事务内 put 同一主键会让游标重访该记录
    await eachCursor(store.openCursor(), Infinity, (cursor) => {
      const row = cursor.value as TabSessionRow
      if (row.ended === true || aliveTabIds.has(row.tabId)) return
      cursor.update({ ...row, ended: true } satisfies TabSessionRow)
      if (row.recording === true) stillRecording.push(row.tabSessionId)
      ended += 1
    })
    // 收尾事件放在游标走完之后补（同 endOpenTabSessions：游标回调是同步的，塞不进 await）
    for (const tabSessionId of stillRecording) {
      addTabEvent(events, { tabSessionId, kind: 'recordOff' })
    }
    await txDone(tx, '对账标签页存续')
    return ended
  })
}

/** 全量表（按登记先后升序）。消费方：活动历史左栏取名字与时刻 */
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

/**
 * 有没有任何一页正在记活动。注册链路据此决定装不装录制件 ——
 * 录制按标签页，而「一页录着」意味着它接下来可能导航到任何 host，故有则全匹配注册、无则一件不装。
 *
 * 判据与取号（`recordingTabSessionId`）同源：未结束 + `recording === true`。
 * 两处必须一致 —— 不一致就会出现「注册了但入站全丢」或「该录却没装」这类静默空转。
 */
export async function hasRecordingTabSession(): Promise<boolean> {
  return (await listTabSessions()).some((r) => r.recording === true && r.ended !== true)
}

// —— 标签页存续轴（tab_events store：六类行同表，除运行条目与错误外不设上限）——

/** 删掉某一存续行的全部行（含采样、运行、动作、错误；级联删除的落点）。@returns 删掉的条数 */
function deleteSessionEvents(store: IDBObjectStore, tabSessionId: string): Promise<number> {
  let removed = 0
  return eachCursor(
    store.index(EV_BY_SESSION_SEQ).openCursor(sessionRange(tabSessionId)),
    Infinity,
    (cursor) => {
      cursor.delete()
      removed += 1
    },
  ).then(() => removed)
}

/**
 * 追加一条存续轴事件（文档级那两支：刷新 / 地址变更；开关事件由 addTabEvent 在别的写入里顺带落）
 * —— **在调用方已打开的事务里**做，不自己开事务。
 *
 * 为什么要这个「事务内的裸操作」：事件必须与引发它的那次写入同事务（开关状态、行内地址、
 * 结束盖章都是），而那些写入各有自己的事务，只能在事务里追加一次，不能再套一层
 * runTx（IndexedDB 的事务不可嵌套）。
 *
 * 不裁剪：这两类只在页面文档重开 / 切开关时各落一条，量级由标签页生命周期天然限制。
 */
function addTabEvent(store: IDBObjectStore, event: TabEventRecord): void {
  store.add(event)
}

/**
 * 往某一存续行上追加一条事件（文档级那两支的入口：刷新 / 地址变更）。
 *
 * 开关事件不走这里 —— 它们由引发它们的写入（建行 / 切开关 / 盖章）在同一事务里顺带落，
 * 见 addTabEvent。
 *
 * 行不存在就 no-op：事件只属于「用户开着记录的那一页」，行都没了说明这页本就不在记
 * （或刚被清掉）—— 观察数据不值得为它补造一行。
 *
 * @param nextUrl 给了就顺手把行内地址更新成它。**必须与事件在同一事务**：「地址变了」这条
 *   事件与「现在地址是这个」是同一件事的两面，分两次写入会让读侧看到自相矛盾的一行
 *   （行内地址还停在旧值，时间线最后一条却说变了）。
 * @returns 是否真落盘了（调用方据此决定要不要广播）
 */
export async function appendTabEvent(
  tabSessionId: string,
  kind: TabEventRecord['kind'],
  nextUrl?: string,
): Promise<boolean> {
  return runTx([TAB_SESSIONS_STORE, TAB_EVENTS_STORE], 'readwrite', async (tx) => {
    const sessions = tx.objectStore(TAB_SESSIONS_STORE)
    const row = await request<TabSessionRow | undefined>(sessions.get(tabSessionId))
    if (row === undefined) {
      await txDone(tx, '写入标签页事件')
      return false
    }
    if (nextUrl && row.url !== nextUrl) sessions.put({ ...row, url: nextUrl })
    addTabEvent(tx.objectStore(TAB_EVENTS_STORE), {
      tabSessionId,
      kind,
      time: Date.now(),
      ...(nextUrl ? { url: nextUrl } : {}),
    })
    await txDone(tx, '写入标签页事件')
    return true
  })
}

/**
 * 追加一条接口采样（kind = 'net'）。与轴上的其它行同表，故读侧按页一次就能拿回整根轴；
 * 判别键只活在存储层，读出来的行各自还是原类型（见 listTabTimeline）。
 *
 * 写侧不裁剪：采样一直留着，只在用户显式清（清某页 / 清全部）时消失 ——
 * 面板要铺出完整时间线，写侧截断会让「这一页到底发了哪些请求」看不全。
 *
 * 归属键（tabSessionId）由调用方带上（SW 按 sender.tab.id 查出后给定，见 dl-bridge 的入站分支）；
 * 缺省时照样落盘，只是不进 by_session_seq 索引，按页读不到它 —— 只有清全部时一并带走。
 */
export async function appendTabCapture(rec: NetCaptureRecord): Promise<void> {
  await runTx(TAB_EVENTS_STORE, 'readwrite', async (tx) => {
    const { id: _generated, ...payload } = rec
    void _generated
    tx.objectStore(TAB_EVENTS_STORE).add({ ...payload, kind: NET_TAB_KIND } satisfies TabCaptureRow)
    await txDone(tx, '保存录制数据')
  })
}

/**
 * 某一存续行的**整根活动轴**：文档事件 / 记录开关 / 接口采样 / 运行条目 / 动作 / 错误一次查回、
 * 按 kind 分成五组。六类同表同索引，故这是一次索引查询 —— 合成一张表的收益就在这里。
 *
 * 面板把前四类按时刻混排成时间线（动作与错误自带所属 runId，用于并上脚本名前缀）。
 *
 * `sinceId` 传上一批的 `maxId` 即只取更新的行（增量跟轴），缺省 0 = 整根轴。两者走同一个
 * 索引、同一个区间构造，差别只在下界 —— 所以「增量」不需要第二条读路径。
 *
 * 时刻缺省的存续轴事件排在最末：目前唯一的来源是划断补的那条「结束记录」，它按定义发生在该行
 * 所有已知事件之后（浏览器都退出了），排在末尾与事实一致 —— 而不是给它猜一个数出来。
 */
export async function listTabTimeline(tabSessionId: string, sinceId = 0): Promise<TabTimeline> {
  const rows = await runTx(TAB_EVENTS_STORE, 'readonly', async (tx) =>
    request<TabTimelineRow[]>(
      tx
        .objectStore(TAB_EVENTS_STORE)
        .index(EV_BY_SESSION_SEQ)
        .getAll(sessionRange(tabSessionId, sinceId)),
    ),
  )
  const out: TabTimeline = {
    events: [],
    captures: [],
    runs: [],
    acts: [],
    errors: [],
    maxId: sinceId,
  }
  for (const row of rows ?? []) {
    if (typeof row.id === 'number' && row.id > out.maxId) out.maxId = row.id
    if (isSessionEventRow(row)) out.events.push(row)
    else if (row.kind === NET_TAB_KIND) out.captures.push(toCapture(row))
    else if (row.kind === RUN_TAB_KIND) out.runs.push(toRunEntry(row))
    else if (row.kind === ACT_TAB_KIND) out.acts.push({ runId: row.runId, event: row.event })
    else out.errors.push(toErrorRecord(row))
  }
  out.events.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity))
  return out
}

/**
 * 存续轴事件全量（文档事件与记录开关，按时刻升序）。
 * 消费方是落盘顺序的观测面（单测据此断言写进去的是什么）。
 */
export async function listTabEvents(): Promise<TabEventRecord[]> {
  const rows = await runTx(TAB_EVENTS_STORE, 'readonly', async (tx) =>
    request<TabTimelineRow[]>(tx.objectStore(TAB_EVENTS_STORE).getAll()),
  )
  return (rows ?? [])
    .filter(isSessionEventRow)
    .sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity))
}

/**
 * 删掉若干存续行的**全部活动**：存续行 + 它在 tab_events 上的每一行（六类一起走）。
 *
 * 合表后这件事只剩一条索引：轴上的行全带 tabSessionId，按 by_session_seq 一次删干净 ——
 * 不必再按 runId 反查运行与错误（那是拆表时代的跨表手术）。
 *
 * 不传 ids = 清空全部，**含无归属的错误行**（注册失败 / 依赖抓取失败，它们没有 tabSessionId，
 * 按页清不到它们，只有清全部时一并带走）：面板清空自当清干净，不留残留。
 *
 * **不动录制开关**：用户在 popup 里给这一页开着的开关是活账，清历史不该把它顺手关掉
 * （那一页该继续录，只是从零开始）。
 *
 * @returns 是否真删掉了东西（调用方据此决定要不要广播）
 */
export async function clearTabActivity(tabSessionIds?: string[]): Promise<boolean> {
  const wanted = tabSessionIds === undefined ? null : new Set(tabSessionIds)
  if (wanted && !wanted.size) return false
  return runTx([TAB_SESSIONS_STORE, TAB_EVENTS_STORE], 'readwrite', async (tx) => {
    const sessions = tx.objectStore(TAB_SESSIONS_STORE)
    const events = tx.objectStore(TAB_EVENTS_STORE)
    let removed = 0
    if (!wanted) {
      removed += (await request<number>(events.count())) ?? 0
      sessions.clear()
      events.clear()
    } else {
      for (const id of wanted) {
        const hit = await request<unknown>(sessions.get(id))
        if (hit === undefined) continue
        sessions.delete(id)
        removed += 1 + (await deleteSessionEvents(events, id))
      }
    }
    await txDone(tx, '清空活动历史')
    return removed > 0
  })
}

/** 该 tabId 现在开着的那一行（未结束 = 还开着；已盖章的不算） */
async function openRowOf(store: IDBObjectStore, tabId: number): Promise<TabSessionRow | undefined> {
  const rows = await request<TabSessionRow[]>(store.index(TABS_BY_TAB).getAll(tabId))
  return (rows ?? []).find((r) => r.ended !== true)
}

/**
 * 裁掉最旧登记的**已结束**行，直到删够 excess 条（连带这些行在 tab_events 上的全部记录）。
 *
 * 未结束的行一律跳过：那是还开着的账，删掉等于凭空丢掉正在开的标签页。极端情况（未结束的行
 * 比上限还多）会删不满，那就到此为止 —— 宁可暂时超一点，也不动活账。
 *
 * 记录不跟着行走就会变成孤儿（读侧按行归组，谁也认不出它属于哪儿），故同事务里一并删。
 */
async function trimEndedTabSessions(
  sessions: IDBObjectStore,
  events: IDBObjectStore,
  excess: number,
): Promise<void> {
  const victims = await new Promise<string[]>((resolve, reject) => {
    const found: string[] = []
    const req = sessions.index(TABS_BY_SEEN).openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor || found.length >= excess) {
        resolve(found)
        return
      }
      const row = cursor.value as TabSessionRow
      if (row.ended === true) {
        found.push(row.tabSessionId)
        cursor.delete()
      }
      cursor.continue()
    }
    req.onerror = () => reject(req.error ?? new Error('裁剪标签页存续表失败'))
  })
  for (const id of victims) await deleteSessionEvents(events, id)
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

/** 清空本库两张表（用例隔离用；usdata-db 也有同名辅助，包根不能撞名） */
export async function clearRuntimeDbForTests(): Promise<void> {
  for (const name of [TAB_SESSIONS_STORE, TAB_EVENTS_STORE]) {
    await runTx(name, 'readwrite', async (tx) => {
      tx.objectStore(name).clear()
      await txDone(tx, '清空观测数据')
    })
  }
}
