<script setup lang="ts">
// 活动历史标签页：以**标签页**为主线的历史视图。
//
// 左栏 = 标签页存续表（`duoling-runtime` 的 tab_sessions）。记录是**被动**的：不为每个新标签页
// 建行，只有用户在 popup 里给某一页打开了「活动记录」，那一页才进这张表 —— 哪怕它此后一次脚本
// 都没跑，也照样列着，右栏那时只有它经历过的事件（视角以标签页为准）。
//
// 右栏 = 选中那一页的活动轴，**全部平铺**（最新在前，没有卡片可展开）：生命周期节点、刷新与
// 地址变更、记录开关、脚本动作、报错、请求 —— 每件都是轴上的一行；动作行与错误行带脚本名
// （同一次运行的归属靠 runId 对上）。
//
// 数据形状（六类行同住 tab_events、合表理由、「只观测开着记录的页」的判据）见 ARCHITECTURE.md「存储」节
// —— 面板侧的红利：一条命令取整根轴、读侧零 join；轴上的行必然都带 tabSessionId，天然看不到
// 别的页的记录（无归属错误只落盘、不出口，见 store.appendUserScriptError）。左栏计数同样按
// tabSessionId 归组。
//
// 数据通道：userscriptClient（workbench 是可信扩展页，可直接发 runtime 消息）。
// 读侧两条命令：tabSessions（存续表，左栏取名字与时刻）/ runlog（全量时间线，供头部概览与卡头计数）；
// 选中页的整根轴另走 tabTimeline（**按页拉**：采样单条可达数 KB，全量等于把整库搬过消息边界）。
// 写侧两条：tabActivityDelete（删某一页）/ tabActivityClear（清空全部）。
//
// 删除 / 清空**连整根轴一起删**是刻意的：面板展示的是它们的合成，只删存续行会让这一页以
// 「表里已查不到」的残影留在列表里（它的轴行还在）。连带删干净 —— 同一份数据，删了就没有了。
//
// 新鲜度：两条通知线合起来覆盖全部变化。跑脚本 / 报错广播 runlog 与 error（重拉左栏计数）；
// 存续行与轴上的行广播 tabActivity —— 结构性变化不带页号（左栏与整根轴一起重读），轴上的新增
// 带页号（只对正在看的那一页、只取游标之后的增量）。「刷新」由此退化成兜底按钮，不再是要不要
// 手动更新的分界。
import { computed, onMounted, ref, watch } from 'vue'
import { useDataSync } from '@duoling/ui/composables/use-data-sync'
import { useVirtualList } from '../composables/use-virtual-list'
import {
  Check as UiCheck,
  Clock as UiClock,
  Copy as UiCopy,
  RefreshCw as UiRefreshCw,
  Trash2 as UiTrash2
} from '@lucide/vue'
import { Button as UiButton } from '@duoling/ui/components/ui/button'
import ConfirmDialog from './ConfirmDialog.vue'
import { webHostname } from '@duoling/shared'
import { routeOf } from '@duoling/shared'
import type { NetCaptureRecord } from '@duoling/shared'
import { userscriptClient } from '@duoling/ui/lib/userscripts/ui-client'
import {
  type TabEventRecord,
  type TabSessionRecord,
  type UserScriptErrorRecord,
  type UserScriptRunEvent,
  type UserScriptRunLogRow
} from '@duoling/shared'
import { errorText } from '@duoling/ui/lib/format'

/**
 * 时间线节点：页面的两个生命周期端点 + 这一页的刷新 / 地址变更与记录开关 + 录到的每一条
 * 请求 + 脚本做过的每一个动作 + 报的每一条错，按时刻混排。它们都只是「同一根时间轴上的点」，
 * 渲染各成一行、互不从属 —— 动作与错误按自己的发生时刻落位，与刷新、请求同级。
 */
type TimelineNode =
  | { kind: 'lifecycle'; label: '页面打开' | '页面关闭'; time: number }
  | { kind: 'tabEvent'; event: TabEventRecord }
  | { kind: 'netRequest'; rec: NetCaptureRecord }
  | { kind: 'act'; key: string; runId: string; name: string; event: UserScriptRunEvent }
  | { kind: 'error'; record: UserScriptErrorRecord }

/** 左栏一行：一个标签页 */
interface TabItem {
  id: string
  /** 左栏显示名：地址能解析出主机就显示主机，否则给一句「地址未知」 */
  label: string
  /** 这一页最近一次被观察到的地址（存续表里的为准） */
  url?: string
  status: 'open' | 'closed'
  runs: number
  errors: number
  createdAt?: number
  closedAt?: number
  /** 排序键（最近一次活动；没有活动就用被观察到的时刻）——列表按它倒序 */
  sortAt: number
}

const sessions = ref<TabSessionRecord[]>([])
/** 存续轴上的事件（刷新 / 地址变更 / 记录开关）：时间线的一类节点，与动作 / 错误按时刻混排 */
const tabEvents = ref<TabEventRecord[]>([])
const rows = ref<UserScriptRunLogRow[]>([])
/** 选中页录到的采样：时间线只画采样本身，会话表不参与渲染 */
const netRecords = ref<NetCaptureRecord[]>([])
/** 选中页的动作（带所属 runId）：轴上平铺的一类节点 */
const pageActs = ref<Array<{ runId: string; event: UserScriptRunEvent }>>([])
/** 选中页的错误：轴上平铺的一类节点（自己带脚本名，不必回查运行） */
const pageErrors = ref<UserScriptErrorRecord[]>([])
/** runId → 这次运行的脚本名与动作总数：动作行挂上脚本名、被截断的动作数由它算 */
const runMetaById = ref<Map<string, { name: string; eventCount: number }>>(new Map())
const loading = ref(false)
const error = ref('')
/** 当前选中的标签页（tabSessionId）；空 = 左栏还没有任何一行 */
const selectedId = ref('')
const copiedErrorId = ref('')

/**
 * 一行属于哪个标签页。`tabSessionId` 就是轴上的归属键，运行条与错误行都直接带它 ——
 * 不必再靠 runId 反查运行（合表把归属键铺到了每一类行上）。
 *
 * 缺省 = 无归属（注册失败 / 依赖抓取失败那类）：它们只落盘、不出口，本面板一律跳过。
 */
function tabIdOf(row: UserScriptRunLogRow): string | undefined {
  return row.kind === 'run' ? row.tabSessionId : row.record.tabSessionId
}

/**
 * 左栏列表：存续表全量（含一次脚本都没跑过的页）。
 *
 * 计数取自全量运行时间线，按归属键归组：运行条数 + 它挂着的错误数 + 单独成行的错误数。
 * 它们只喂头部概览与右栏卡头，**不在行内铺开**（行内只写主机名与状态词）。
 * 无归属的行（注册失败 / 依赖抓取失败）在这里被跳过 —— 它们不出口，左栏也不给它们留格子。
 */
const tabItems = computed<TabItem[]>(() => {
  const stat = new Map<string, { runs: number; errors: number; last: number }>()
  for (const row of rows.value) {
    const id = tabIdOf(row)
    if (!id) continue
    const cur = stat.get(id) ?? { runs: 0, errors: 0, last: 0 }
    if (row.kind === 'run') {
      cur.runs += 1
      cur.last = Math.max(cur.last, row.time)
      // 挂在这次运行上的错误：它们不是单独的行，计数得在这里一并算上
      for (const e of row.errors) {
        cur.errors += 1
        cur.last = Math.max(cur.last, e.time)
      }
    } else {
      cur.errors += 1
      cur.last = Math.max(cur.last, row.record.time)
    }
    stat.set(id, cur)
  }
  return sessions.value
    .map((s): TabItem => {
      const agg = stat.get(s.tabSessionId)
      return {
        id: s.tabSessionId,
        label: webHostname(s.url) || '地址未知',
        url: s.url,
        status: s.ended === true ? 'closed' : 'open',
        runs: agg?.runs ?? 0,
        errors: agg?.errors ?? 0,
        createdAt: s.createdAt,
        closedAt: s.closedAt,
        sortAt: agg?.last ?? s.createdAt ?? s.closedAt ?? 0
      }
    })
    .sort((a, b) => b.sortAt - a.sortAt)
})

const selected = computed<TabItem | null>(
  () => tabItems.value.find((i) => i.id === selectedId.value) ?? null
)

/** 有活动（跑过脚本或出过错）的页数：头部概览用 */
const activeCount = computed(() => tabItems.value.filter((i) => i.runs || i.errors).length)

/** 选中页此刻的实时 tabId（在录才有）：卡头「停止记录」的显隐与参数都由它决定 */
const selectedLiveTabId = computed<number | null>(() => {
  const sel = selected.value
  return sel ? liveTabIdOf(sel.id) : null
})

/** 右栏时间线：生命周期端点 + 该页的刷新 / 地址变更与记录开关 + 该页的动作与错误 +
 *  它录到的每一条请求，全部平铺在同一根轴上，最新在前 */
const timelineNodes = computed<TimelineNode[]>(() => {
  const sel = selected.value
  if (!sel) return []
  const nodes: TimelineNode[] = []
  // 生命周期端点只在**记到了**时刻时才画：缺省就是未知，不拿别的时刻顶上
  if (sel.createdAt) nodes.push({ kind: 'lifecycle', label: '页面打开', time: sel.createdAt })
  if (sel.closedAt) nodes.push({ kind: 'lifecycle', label: '页面关闭', time: sel.closedAt })
  // 文档事件 / 记录开关 / 动作 / 错误 / 采样都是**选中的这一页**的（一条命令按页拉，见
  // loadPageTimeline），直接铺上去即可 —— 不必再按归属键筛一遍
  for (const event of tabEvents.value) nodes.push({ kind: 'tabEvent', event })
  pageActs.value.forEach((act, i) => {
    nodes.push({
      // 动作行没有独立的存储身份传过来，用「运行 + 在这页动作里的序号」当行 key（同一页内唯一）
      kind: 'act',
      key: `act:${act.runId}:${i}`,
      runId: act.runId,
      name: runMetaById.value.get(act.runId)?.name ?? '',
      event: act.event
    })
  })
  for (const record of pageErrors.value) nodes.push({ kind: 'error', record })
  // 录到的采样：一条一个节点，按自己的发生时刻落位 —— 这样「刷新后先发了哪个请求、紧接着
  // 脚本做了什么」在轴上一眼看得出。
  for (const rec of netRecords.value) nodes.push({ kind: 'netRequest', rec })
  // 最新在前；时刻缺省的排在最前 —— 与 tabTimeline 侧事件的升序口径一致（它按定义发生在该行
  // 所有已知节点之后，比如划断补的那条「结束记录」）
  return nodes.sort((a, b) => (nodeTime(b) ?? Infinity) - (nodeTime(a) ?? Infinity))
})

function nodeTime(node: TimelineNode): number | undefined {
  if (node.kind === 'act') return node.event.time
  if (node.kind === 'error') return node.record.time
  if (node.kind === 'tabEvent') return node.event.time
  if (node.kind === 'netRequest') return node.rec.t
  return node.time
}

function nodeKey(node: TimelineNode): string {
  if (node.kind === 'act') return node.key
  if (node.kind === 'error') return `err:${node.record.id}`
  if (node.kind === 'tabEvent') {
    return `tabevent:${node.event.tabSessionId}:${node.event.time}:${node.event.kind}`
  }
  if (node.kind === 'netRequest') return `netreq:${String(node.rec.id)}`
  return `life:${node.label}`
}

/** 时间线的滚动容器：窗口化要读它的视口高与 scrollTop，reset 时也要把它拨回顶部 */
const scrollRef = ref<HTMLElement | null>(null)

/**
 * 时间线的窗口化渲染：录到的采样全平铺后，单页行数可能上千，故只渲染视口内的行。
 * 行高不等（运行卡展开会变高、错误卡带 stack），交给 composable 实测 —— 见它的文件头。
 */
const { onScroll, totalHeight, offsetTop, visibleRows, setRowRef, reset: resetVirtual } =
  useVirtualList<TimelineNode>(timelineNodes, scrollRef)

/** 选中项消失（被裁掉 / 数据重拉）时回落第一项：停在空视图上会像页面坏了 */
function fallbackSelection(): void {
  if (!tabItems.value.some((i) => i.id === selectedId.value)) {
    selectedId.value = tabItems.value[0]?.id ?? ''
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [sessionList, logRows] = await Promise.all([
      userscriptClient.tabSessions(),
      userscriptClient.runlog()
    ])
    sessions.value = sessionList
    rows.value = logRows
    fallbackSelection()
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}

/** 选中页已拉到的位置（存储层给的 maxId）：增量续拉的游标，切页 / 整根重读时归零 */
const timelineCursor = ref(0)

/**
 * 拉选中页的活动轴：文档事件 / 记录开关 / 接口采样 / 运行条目 / 动作 / 错误六类同住
 * tab_events，故一条命令一次拉回。运行条目只取名字与动作总数（动作行要挂脚本名、被截断的
 * 要报数），本体不再单独成行。
 *
 * **只拉这一页**，不做全量预取：采样单条可达数 KB，给每一页都拉一遍纯属浪费。切页时重拉。
 *
 * `append` = 只取比游标新的行接着拼：录制中轴一直在长，整根重读的代价随轴长线性上涨，
 * 增量则只与新增条数有关。游标用存储层返回值里的 `maxId`，不在这里从各行自己求 —— 轴上的行
 * 读出来是业务投影，不一定都带主键，漏算一类会让游标停住、时间线看着不涨。
 */
async function loadPageTimeline(tabSessionId: string, append = false): Promise<void> {
  if (!append) {
    tabEvents.value = []
    netRecords.value = []
    pageActs.value = []
    pageErrors.value = []
    runMetaById.value = new Map()
    timelineCursor.value = 0
  }
  if (!tabSessionId) return
  try {
    const res = await userscriptClient.tabTimeline(tabSessionId, timelineCursor.value)
    // 增量一律拼在尾部、不重排：数组顺序就是落盘序，动作行的行 key 用它在这批里的序号
    tabEvents.value = append ? [...tabEvents.value, ...res.events] : res.events
    netRecords.value = append ? [...netRecords.value, ...res.captures] : res.captures
    pageActs.value = append ? [...pageActs.value, ...res.acts] : res.acts
    pageErrors.value = append ? [...pageErrors.value, ...res.errors] : res.errors
    const meta = new Map(runMetaById.value)
    for (const r of res.runs) meta.set(r.runId, { name: r.name, eventCount: r.eventCount ?? 0 })
    runMetaById.value = meta
    timelineCursor.value = res.maxId
  } catch (e) {
    error.value = '读取这一页的活动失败：' + errorText(e)
  }
}

onMounted(() => void load())

// 切页就换一份这一页的时间线，并把窗口化渲染的实测高度清掉（行内容整批换了，旧高度会错位）
watch(selectedId, (id) => {
  resetVirtual()
  void loadPageTimeline(id)
})

// 跑脚本会广播这两个域（运行条目 / 错误）：它们计入左栏的计数，故接上就不用手动刷新。
// 左栏的名单只跟存续表走，这两条只重拉左栏即可。
useDataSync('runlog', async () => {
  await load()
})
useDataSync('error', async () => {
  await load()
})
// 标签页活动记录（存续表与轴上的行）：
//   · 不带页号 = 结构性变化（建行 / 关页 / 开关记录 / 划断对账 / 删除清空）—— 左栏名单与
//     右栏轴都可能整批变，两边一起重读（增量游标此时已无从续起，必须整根重新对齐）；
//   · 带页号   = 只有那一页的轴长了新行 —— 正是**正在看的这一页**才增量续拉。别的页长什么
//     样与当前视图无关；采样也不参与左栏计数，故左栏不必动。
useDataSync('tabActivity', async (push) => {
  if (push.uuid) {
    // 带页号 = 只有那一页的轴长了新行：正在看它就增量续拉；别的页长什么样与当前视图无关
    if (push.uuid === selectedId.value) await loadPageTimeline(push.uuid, true)
    return
  }
  // 不带页号 = 结构性变化：左栏名单与右栏轴都可能整批变，两边一起重读。
  // 选中项若被左栏重算换掉了（新页更近 / 当前页被删），这一根就不必再拉 —— watch 已经按
  // 新的选中页拉过一整根，这里再拉一次等于把它的轴白读一遍。
  const selected = selectedId.value
  await load()
  if (selectedId.value === selected) await loadPageTimeline(selected)
})

// —— 页面录制（融合自原「接口数据」面板：录制与活动记录本就是同一枚开关的两半）——
//
// 判据只有一个：存续行上的 `recording`（未结束的那一行）—— 录制与活动记录同一枚开关，
// 故不需要另问一次「谁在录」。

/** 展开的请求行：逐条点开才看头体 */
const openNetRows = ref<Set<string>>(new Set())
/** 停止录制在途（禁灰，防连点重复发命令） */
const stoppingTabId = ref<number | null>(null)

/** 正在记录的 tabSessionId（左栏圆点的判据）：未结束 + recording，与取号同一条判据 */
const recordingTabSessionIds = computed(
  () =>
    new Set(
      sessions.value
        .filter((s) => s.recording === true && s.ended !== true)
        .map((s) => s.tabSessionId)
    )
)

/** 某个 tabSessionId 此刻对应的实时 tabId（停记录要用它发命令）；没在录返回 null */
function liveTabIdOf(tabSessionId: string): number | null {
  const row = sessions.value.find(
    (s) => s.tabSessionId === tabSessionId && s.recording === true && s.ended !== true
  )
  return row?.tabId ?? null
}

/**
 * 就地停掉某一页的录制 —— 它就是关掉那一页的记录开关（录制与活动记录同一枚开关）。
 * 存续行与已录内容都留着，只是不再长新的；停完重拉，时间线上会多出一条「结束记录」。
 */
async function stopRecording(tabId: number): Promise<void> {
  if (stoppingTabId.value != null) return
  stoppingTabId.value = tabId
  error.value = ''
  try {
    await userscriptClient.tabActivityDisable(tabId)
    await load()
    await loadPageTimeline(selectedId.value)
  } catch (e) {
    error.value = errorText(e)
  } finally {
    stoppingTabId.value = null
  }
}

/** 卡头那颗按钮的落点：从派生量里取一次实时 tabId，取不到就当这一页此刻并不在录 */
function stopSelectedRecording(): void {
  const tabId = selectedLiveTabId.value
  if (tabId != null) void stopRecording(tabId)
}

/** 请求行的展开态 key：rec.id 自增且唯一 */
function netRowKey(rec: NetCaptureRecord): string {
  return String(rec.id)
}

function toggleNetRow(key: string): void {
  const next = new Set(openNetRows.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  openNetRows.value = next
}

/** 时间线圆点配色：请求行与动作行都淡一档，免得一屏采样把错误行压过去 */
function dotBg(node: TimelineNode): string {
  if (node.kind === 'lifecycle' || node.kind === 'tabEvent') return 'bg-muted-foreground/40'
  if (node.kind === 'netRequest') return 'bg-primary/40'
  if (node.kind === 'error') return 'bg-destructive'
  return 'bg-muted-foreground/60'
}

/** 头字典的展示文本（展开请求行时逐行列出） */
function headerText(h: Record<string, string>): string {
  return Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

async function copyErrorId(id: string | undefined): Promise<void> {
  if (!id) return
  try {
    await navigator.clipboard.writeText(id)
    copiedErrorId.value = id
    window.setTimeout(() => (copiedErrorId.value = ''), 1500)
  } catch (e) {
    error.value = '复制失败：' + errorText(e)
  }
}

/**
 * 轴上没显示出来的动作条数：运行条的 eventCount 是收到总数，落盘条数受单次运行上限封顶。
 * 平铺后动作行各占一行，这条差额改在轴尾单独说一句（它不再挂在某张运行卡上）。
 */
const omittedActCount = computed(() => {
  const shown = new Map<string, number>()
  for (const act of pageActs.value) shown.set(act.runId, (shown.get(act.runId) ?? 0) + 1)
  let omitted = 0
  for (const [runId, meta] of runMetaById.value) {
    omitted += Math.max(0, meta.eventCount - (shown.get(runId) ?? 0))
  }
  return omitted
})

const PHASE_LABEL: Record<UserScriptErrorRecord['phase'], string> = {
  runtime: '运行期',
  register: '未生效',
  bridge: 'GM 桥',
  require: '@require 抓取',
  resource: '@resource 抓取'
}
/** 阶段配色走语义 token（不硬编码色值、不手写 dark: 覆盖）：运行期最需要关注 → destructive */
const PHASE_BADGE: Record<UserScriptErrorRecord['phase'], string> = {
  runtime: 'bg-destructive/10 text-destructive',
  register: 'bg-muted text-muted-foreground',
  bridge: 'bg-primary/10 text-primary',
  require: 'bg-muted text-muted-foreground',
  resource: 'bg-muted text-muted-foreground'
}
function phaseLabel(p: UserScriptErrorRecord['phase']): string {
  return PHASE_LABEL[p]
}
function phaseBadgeClass(p: UserScriptErrorRecord['phase']): string {
  return PHASE_BADGE[p]
}

const STATUS_LABEL: Record<TabItem['status'], string> = {
  open: '活动中',
  closed: '已关闭'
}
/**
 * 行尾状态词：只写**非默认态**。
 *
 * 默认态 = 「页还开着、没在录」，列表里多数如此 —— 它不需要任何标记，于是「正在记录」与
 * 「已关闭」一出现就是值得看一眼的那两行。两者互斥：标签页关闭时那一行会被盖章结束，
 * 录制判据（未结束 + recording）随之失效。
 */
function statusText(item: TabItem): string {
  if (recordingTabSessionIds.value.has(item.id)) return '正在记录'
  return item.status === 'closed' ? STATUS_LABEL.closed : ''
}

function formatDateTime(t: number): string {
  return new Date(t).toLocaleString()
}
/** 时间线节点上的时刻：只到秒（日期在卡头已有，重复一遍是噪声） */
function formatClock(t: number): string {
  return new Date(t).toLocaleTimeString()
}
/** 存活时长：跨度可能从几秒到几小时，逐级降精度（秒 → 分秒 → 时分） */
function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec} 秒`
  const min = Math.floor(sec / 60)
  const rsec = sec % 60
  if (min < 60) return rsec ? `${min} 分 ${rsec} 秒` : `${min} 分`
  const hour = Math.floor(min / 60)
  const rmin = min % 60
  return rmin ? `${hour} 小时 ${rmin} 分` : `${hour} 小时`
}
/** 标签页事件文案：四类各是一件事（换了文档 / 换了去处 / 开始记 / 不再记），别混成一句「页面变化」 */
const TAB_EVENT_LABEL: Record<TabEventRecord['kind'], string> = {
  reload: '页面刷新',
  url: '地址变更',
  recordOn: '开始记录',
  recordOff: '结束记录'
}
function tabEventLabel(event: TabEventRecord): string {
  return TAB_EVENT_LABEL[event.kind]
}

/** 事件上的钟点；时刻缺省时不编一个顶上，如实写「时刻未知」（见 TabEventRecord.time） */
function tabEventClock(event: TabEventRecord): string {
  return event.time === undefined ? '时刻未知' : formatClock(event.time)
}

/** 错误 ID 展示短形态（前 8 位；复制按钮复制完整 id，供 AI 代查） */
function shortErrorId(id: string | undefined): string {
  return id ? id.slice(0, 8) : ''
}

/**
 * 卡头那行时刻：缺的部分如实写「未知」，不拿别的时刻顶上。
 *
 * 「打开」只在真有时刻时才说：记录改为被动后，建行发生在「用户打开记录」或「脚本跑起来」，
 * 都不是标签页出生的时刻，故 `createdAt` 对新记录恒缺省（见 TabSessionRecord）——
 * 天天挂一句「打开时刻未知」只是噪音，而关闭时刻仍缺不得（那是真会缺的）。
 */
const momentsText = computed(() => {
  const sel = selected.value
  if (!sel) return ''
  const parts: string[] = []
  if (sel.createdAt) parts.push(`打开 ${formatDateTime(sel.createdAt)}`)
  if (sel.closedAt) parts.push(`关闭 ${formatDateTime(sel.closedAt)}`)
  else if (sel.status === 'closed') parts.push('关闭时刻未知')
  return parts.join(' · ')
})

/** 存活时长：两个端点都记到了才算，缺一个就不显示（算不出来不算） */
const aliveText = computed(() => {
  const sel = selected.value
  if (!sel?.createdAt || !sel?.closedAt) return ''
  return `存活 ${formatDuration(sel.closedAt - sel.createdAt)}`
})

/** 删除 / 清空进行中：按钮置灰，防连点（清空不可撤销） */
const mutating = ref(false)
const confirmOpen = ref(false)
const confirmKind = ref<'clear' | 'delete'>('clear')

/** 选中一页就能删它（列表里全是具体的一页） */
const canDeleteSelected = computed(() => !!selected.value)

const confirmTitle = computed(() =>
  confirmKind.value === 'clear' ? '清空活动历史' : '删除这一页的活动记录'
)
const confirmDescription = computed(() => {
  const tail = '删除后无法恢复。'
  if (confirmKind.value === 'clear') {
    return `将删除全部标签页的活动记录（各自的事件、录到的请求、脚本运行与错误）。${tail}`
  }
  return `将删除「${selected.value?.label ?? ''}」的活动记录（它的事件、录到的请求、脚本运行与错误）。${tail}`
})

function askClear(): void {
  confirmKind.value = 'clear'
  confirmOpen.value = true
}
function askDelete(): void {
  confirmKind.value = 'delete'
  confirmOpen.value = true
}

async function doClear(): Promise<void> {
  mutating.value = true
  try {
    await userscriptClient.tabActivityClear()
    await load() // load 末尾会回落选中项：清空后停留在已消失的页上会像坏了
  } catch (e) {
    error.value = '清空失败：' + errorText(e)
  } finally {
    mutating.value = false
  }
}

async function doDelete(): Promise<void> {
  const sel = selected.value
  if (!sel) return
  mutating.value = true
  try {
    await userscriptClient.tabActivityDelete(sel.id)
    await load()
  } catch (e) {
    error.value = '删除失败：' + errorText(e)
  } finally {
    mutating.value = false
  }
}

function onConfirmedAction(): void {
  const kind = confirmKind.value
  void (kind === 'clear' ? doClear() : doDelete())
}
</script>

<template>
  <!-- 根用 h-full 而非 flex-1：宿主 ui-tabs-content 不是 flex 容器，flex-1 撑不开高度 -->
  <div class="flex h-full min-h-0 flex-col">
    <!-- 头部：说明 + 概览 + 刷新 -->
    <div class="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
      <ui-clock class="size-4 text-muted-foreground" />
      <span class="text-sm font-medium">活动历史</span>
      <span class="text-xs text-muted-foreground">
        共 {{ tabItems.length }} 个标签页<template v-if="activeCount"> · {{ activeCount }} 个有活动</template>
      </span>
      <span class="flex-1" />
      <ui-button
        v-if="tabItems.length"
        variant="ghost"
        size="sm"
        class="h-7 gap-1 px-2.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        title="删除全部标签页的活动记录（含它们的运行与错误），不可撤销"
        data-testid="tab-activity-clear"
        :disabled="mutating || loading"
        @click="askClear"
      >
        <ui-trash-2 class="size-3.5" />
        清空
      </ui-button>
      <ui-button
        variant="ghost"
        size="sm"
        class="h-7 gap-1 px-2.5 text-xs"
        title="重新拉取标签页与运行记录"
        :disabled="loading"
        @click="load"
      >
        <ui-refresh-cw class="size-3.5" :class="{ 'animate-spin': loading }" />
        刷新
      </ui-button>
    </div>

    <p
      v-if="error"
      class="mx-4 mt-3 shrink-0 rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive"
    >
      {{ error }}
    </p>

    <!-- 双栏常驻：左栏是这一页的入口，即便一条记录都没有也要可见 -->
    <div class="flex min-h-0 flex-1">
      <!-- 左栏：标签页列表（主机名 + 行尾状态词）—— 一行一项，不带活动摘要：摘要只数脚本，
           在只录到请求的页上会被读成「这一页没活动」，而真值在右栏卡头 -->
      <div class="flex w-64 shrink-0 flex-col border-r border-border">
        <nav class="min-h-0 flex-1 overflow-y-auto py-2" aria-label="标签页列表">
          <p v-if="!tabItems.length" class="px-3 py-2 text-xs text-muted-foreground">
            {{ loading ? '加载中…' : '还没有标签页记录。在 popup 里给页面打开「活动记录」后，这里会列出来。' }}
          </p>
          <button
            v-for="item in tabItems"
            :key="item.id"
            type="button"
            class="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs hover:bg-muted"
            :class="item.id === selectedId ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'"
            :title="item.url ?? item.label"
            @click="selectedId = item.id"
          >
            <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
            <span
              v-if="statusText(item)"
              class="shrink-0 text-[10px]"
              :class="recordingTabSessionIds.has(item.id) ? 'text-foreground' : ''"
            >{{ statusText(item) }}</span>
          </button>
        </nav>
      </div>

      <!-- 右栏：选中标签页的活动（头部常驻，时间线独立滚动 —— 长列表滚动时头部不跟着走） -->
      <div class="flex min-w-0 flex-1 flex-col" data-testid="tab-activity-detail">
        <div class="shrink-0 px-4 pt-4">
          <div class="mx-auto max-w-3xl">
            <p v-if="!selected" class="text-xs text-muted-foreground">从左边选一个标签页看它的活动。</p>

            <header v-else class="border-b border-border pb-3">
              <div class="flex flex-wrap items-center gap-2">
                <span class="min-w-0 truncate text-sm font-medium">{{ selected.label }}</span>
                <span class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {{ STATUS_LABEL[selected.status] }}
                </span>
                <span class="flex-1" />
                <span class="shrink-0 text-xs text-muted-foreground">
                  运行 {{ selected.runs }} 次<template v-if="selected.errors"> · 错误 {{ selected.errors }} 条</template>
                </span>
                <ui-button
                  v-if="selectedLiveTabId != null"
                  variant="ghost"
                  size="sm"
                  class="h-6 shrink-0 px-2 text-xs text-muted-foreground"
                  title="停掉这一页的记录（存续行与已录内容都留着）"
                  data-testid="tab-activity-stop"
                  :disabled="stoppingTabId != null"
                  @click="stopSelectedRecording"
                >
                  停止记录
                </ui-button>
                <ui-button
                  v-if="canDeleteSelected"
                  variant="ghost"
                  size="sm"
                  class="h-6 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="删除这一页的活动记录（含它的运行与错误），不可撤销"
                  data-testid="tab-activity-delete"
                  :disabled="mutating"
                  @click="askDelete"
                >
                  <ui-trash-2 class="size-3" />
                  删除
                </ui-button>
              </div>
              <p v-if="selected.url" class="mt-1 truncate text-xs text-muted-foreground" :title="selected.url">
                {{ selected.url }}
              </p>
              <p v-if="momentsText" class="mt-1 text-[11px] text-muted-foreground">
                {{ momentsText }}<template v-if="aliveText"> · {{ aliveText }}</template>
              </p>
            </header>
          </div>
        </div>

        <!--
          时间线独立滚动：头部常驻，长列表滚起来时它不跟着走。
          全部节点平铺在同一根轴上 —— 录到的每一条请求、脚本做过的每一个动作、报的每一条错
          都与刷新同级，按各自的时刻落位，没有卡片要展开。
          行数可能上千，故只渲染视口内的行（窗口化）。竖线由背景层统一画：视口外的行不在 DOM 里，
          逐行画会断成一段一段。
        -->
        <div ref="scrollRef" class="min-h-0 flex-1 overflow-y-auto" @scroll="onScroll">
          <div class="mx-auto max-w-3xl px-4 pb-4">
            <div
              v-if="selected && timelineNodes.length"
              class="tab-activity-timeline relative mt-3"
              :style="{ height: `${totalHeight}px`, paddingTop: `${offsetTop}px` }"
            >
              <span
                class="pointer-events-none absolute top-0 left-2.5 h-full w-px bg-border"
                aria-hidden="true"
              />
              <div
                v-for="r in visibleRows"
                :key="nodeKey(r.item)"
                :ref="(el) => setRowRef(r.index, el as Element | null)"
                class="grid grid-cols-[1.25rem_minmax(0,1fr)] items-start"
              >
                <div class="flex justify-center pt-2">
                  <span class="size-1.5 rounded-full" :class="dotBg(r.item)" aria-hidden="true" />
                </div>

                <div class="min-w-0 pb-2.5">
                  <!-- 页面生命周期端点：只在记到了时刻才画（缺时刻的说明在卡头） -->
                  <p
                    v-if="r.item.kind === 'lifecycle'"
                    class="flex flex-wrap items-center gap-1.5 pt-1 text-[11px] text-muted-foreground"
                  >
                    <span>{{ r.item.label }}</span>
                    <span class="tabular-nums">{{ formatDateTime(r.item.time) }}</span>
                  </p>

                  <!-- 标签页事件（刷新 / 地址变更 / 记录开关）：没有脚本参与，一行小字说清发生了什么，不占卡片 -->
                  <p
                    v-else-if="r.item.kind === 'tabEvent'"
                    class="flex flex-wrap items-baseline gap-1.5 pt-1 text-[11px] text-muted-foreground"
                  >
                    <span>{{ tabEventLabel(r.item.event) }}</span>
                    <span class="tabular-nums">{{ tabEventClock(r.item.event) }}</span>
                    <span
                      v-if="r.item.event.kind === 'url' && r.item.event.url"
                      class="min-w-0 truncate"
                      :title="r.item.event.url"
                    >
                      {{ r.item.event.url }}
                    </span>
                  </p>

                  <!-- 录到的一条请求：与刷新、运行同级平铺，按自己的发生时刻落位 -->
                  <div v-else-if="r.item.kind === 'netRequest'" class="rounded-md border border-border bg-card">
                    <button
                      type="button"
                      class="flex w-full items-center gap-1.5 px-1.5 py-1 text-left hover:bg-muted/50"
                      @click="toggleNetRow(netRowKey(r.item.rec))"
                    >
                      <span class="shrink-0 font-mono text-[10px] font-medium">{{ r.item.rec.method }}</span>
                      <span class="min-w-0 flex-1 truncate font-mono text-[10px]" :title="r.item.rec.url">
                        {{ routeOf(r.item.rec.url) }}
                      </span>
                      <span class="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                        {{ formatClock(r.item.rec.t) }}
                      </span>
                      <span
                        class="shrink-0 rounded px-1 text-[10px] tabular-nums"
                        :class="
                          r.item.rec.status >= 400
                            ? 'bg-destructive/10 text-destructive'
                            : 'bg-muted text-muted-foreground'
                        "
                      >
                        {{ r.item.rec.status }}
                      </span>
                    </button>
                    <div
                      v-if="openNetRows.has(netRowKey(r.item.rec))"
                      class="border-t border-border/60 px-2 py-1.5"
                    >
                      <p class="font-mono text-[10px] leading-relaxed break-all">
                        {{ r.item.rec.url }}（{{ r.item.rec.type }}）
                      </p>
                      <template v-if="Object.keys(r.item.rec.reqHeaders).length">
                        <h4 class="mt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          请求头
                        </h4>
                        <pre class="mt-0.5 max-h-32 overflow-auto rounded bg-muted/50 p-1 font-mono text-[10px] leading-relaxed">{{ headerText(r.item.rec.reqHeaders) }}</pre>
                      </template>
                      <template v-if="r.item.rec.reqBody">
                        <h4 class="mt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          请求体
                        </h4>
                        <pre class="mt-0.5 max-h-32 overflow-auto rounded bg-muted/50 p-1 font-mono text-[10px] leading-relaxed">{{ r.item.rec.reqBody }}</pre>
                      </template>
                      <template v-if="Object.keys(r.item.rec.respHeaders).length">
                        <h4 class="mt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          响应头
                        </h4>
                        <pre class="mt-0.5 max-h-32 overflow-auto rounded bg-muted/50 p-1 font-mono text-[10px] leading-relaxed">{{ headerText(r.item.rec.respHeaders) }}</pre>
                      </template>
                      <template v-if="r.item.rec.respBody">
                        <h4 class="mt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          响应结构
                        </h4>
                        <pre class="mt-0.5 max-h-32 overflow-auto rounded bg-muted/50 p-1 font-mono text-[10px] leading-relaxed">{{ r.item.rec.respBody }}</pre>
                      </template>
                    </div>
                  </div>

                  <!-- 脚本做过的一个动作：平铺在轴上的一行，带脚本名前缀（同一次运行的归属靠 runId 对上） -->
                  <p
                    v-else-if="r.item.kind === 'act'"
                    class="flex flex-wrap items-baseline gap-1.5 pt-1 text-[11px] text-muted-foreground"
                  >
                    <span class="shrink-0 font-medium text-foreground">
                      {{ r.item.name || r.item.runId.slice(0, 8) }}
                    </span>
                    <span class="shrink-0 font-mono">{{ r.item.event.kind }}</span>
                    <span class="shrink-0 tabular-nums">{{ formatClock(r.item.event.time) }}</span>
                    <span class="min-w-0 flex-1 truncate" :title="r.item.event.detail">
                      {{ r.item.event.detail }}
                    </span>
                  </p>

                  <!-- 报的一条错：与动作同轴平铺（阶段徽标 + 脚本名 + 消息；栈按需看） -->
                  <div v-else class="rounded-md border bg-card p-2.5 text-xs">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span :class="phaseBadgeClass(r.item.record.phase)" class="rounded px-1.5 py-0.5 text-[10px] font-medium">
                        {{ phaseLabel(r.item.record.phase) }}
                      </span>
                      <span class="min-w-0 truncate font-medium">{{ r.item.record.name }}</span>
                      <span class="text-muted-foreground">{{ formatClock(r.item.record.time) }}</span>
                      <button
                        type="button"
                        class="ml-auto flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted"
                        :title="`复制完整错误 ID（发给 AI 可自动查询修复）：${r.item.record.id}`"
                        @click="copyErrorId(r.item.record.id)"
                      >
                        <ui-check v-if="copiedErrorId === r.item.record.id" class="size-3 text-green-600" />
                        <ui-copy v-else class="size-3" />
                        {{ shortErrorId(r.item.record.id) }}
                      </button>
                    </div>
                    <p class="mt-1 break-all text-destructive">{{ r.item.record.message }}</p>
                    <p v-if="r.item.record.url" class="mt-0.5 truncate text-muted-foreground" :title="r.item.record.url">
                      {{ r.item.record.url }}
                    </p>
                    <pre
                      v-if="r.item.record.stack"
                      class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-[11px] leading-relaxed"
                    >{{ r.item.record.stack }}</pre>
                  </div>
                </div>
              </div>
            </div>
            <!-- 触顶被截掉的动作：不挂在某张运行卡上，改在轴尾说一句（读侧靠计数差额得出） -->
            <p v-if="omittedActCount" class="mt-1 pl-5 text-[11px] text-muted-foreground">
              另有 {{ omittedActCount }} 个动作已省略（超过单次运行上限）
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- 删 / 清都是不可撤销的：走确认弹窗，别让一次误点抹掉历史 -->
    <ConfirmDialog
      v-model:open="confirmOpen"
      danger
      :title="confirmTitle"
      :description="confirmDescription"
      :confirm-text="confirmKind === 'clear' ? '清空' : '删除'"
      @confirm="onConfirmedAction"
    />
  </div>
</template>
