<script setup lang="ts">
// 运行日志标签页：按时间倒序的运行流水（一行 = 一次运行），运行期错误按 runId 挂到所属
// 运行行下、运行内动作按 runId 索引存放——**都只在展开时才呈现**（动作更是展开那一刻才拉，
// 列表不随行返回）；无法归属的错误（注册/桥类无 runId、或所属运行已滑出环形）单独成行。
//
// 运行 + 错误合并成一条时间线（不按脚本分组）——「什么时候跑过、那次挂没挂、挂了什么」一眼一条线看完。
//
// 数据通道：userscriptClient（workbench 是可信扩展页，可直接 chrome.runtime.sendMessage，
// 不走 window.api —— 那是给平移来的桌面版 UI 组件用的 PreloadApi 契约）。
import { computed, onMounted, ref, watch } from 'vue'
import { useDataSync } from '@/composables/use-data-sync'
import {
  Check as UiCheck,
  Copy as UiCopy,
  History as UiHistory,
  RefreshCw as UiRefreshCw,
  Trash2 as UiTrash2
} from '@lucide/vue'
import { Badge as UiBadge } from '@/components/ui/badge'
import { Button as UiButton } from '@/components/ui/button'
import { userscriptClient } from '@/lib/userscripts/ui-client'
import {
  RUN_LOG_MAX,
  type RunEndReason,
  type ScriptSummary,
  type UserScriptErrorRecord,
  type UserScriptRunEvent,
  type UserScriptRunLogRow
} from '@/lib/userscripts/types'

/** 时间线里的一行（运行内事件 / 运行期错误混排）；RunRow 见下 */
type RunRow = Extract<UserScriptRunLogRow, { kind: 'run' }>
interface TimelineItem {
  kind: 'event' | 'error'
  time: number
  /** 事件才有：命令名与已脱敏的一行摘要 */
  label: string
  detail: string
  /** 错误才有 */
  record?: UserScriptErrorRecord
}

/** 深链定位：对话界面灵动岛「点击脚本行」→ workbench.html#/errors/<uuid> → 宿主传入。
 *  带 focusSeq（宿主每次定位请求递增）：标签页常驻不重挂，对同一脚本再点一次时
 *  focusUuid 不变，只靠 uuid 无法触发 watch —— seq 是「这次请求」的标识。
 *  reloadSeq 同理由宿主递增（脚本被删除后要求重拉），见文件末 watch。 */
const props = defineProps<{ focusUuid?: string | null; focusSeq?: number; reloadSeq?: number }>()

/** 「全部」伪分组 key：不是一个真实脚本，仅表示「看全部」 */
const ALL_KEY = '__all__'
/** 「未归属」分组 key：无运行上下文的错误（注册失败无脚本上下文、部分桥错误） */
const ORPHAN_KEY = '__orphan__'

const rows = ref<UserScriptRunLogRow[]>([])
const loading = ref(false)
const error = ref('')
/** 当前选中过滤 key（默认「全部」） */
const selectedKey = ref<string>(ALL_KEY)
/** 深链目标在当前日志里不存在时的说明（否则用户只看到「点了没反应」） */
const focusMissName = ref('')
/** 展开的运行行（runId 集合；展开才拉那一组事件并显示错误明细） */
const expandedRunIds = ref<Set<string>>(new Set())
/**
 * 已拉回的事件（runId → 事件列表）：展开时按需拉，拉过就缓存。
 * 列表视图不带事件——事件单独一表，跟随运行数全量读会线性膨胀（运行数 × 事件上限），
 * 面板只在这张卡片被展开时才问一次 SW。
 */
const eventsByRunId = ref<Map<string, UserScriptRunEvent[]>>(new Map())
/** 正在拉事件的运行行（展开瞬间显示加载态） */
const loadingRunIds = ref<Set<string>>(new Set())

/** 已加载的脚本全量列表（userscriptClient.list）；与日志合并出左栏，让没日志的脚本也可见 */
const scriptList = ref<ScriptSummary[]>([])

/** 左栏过滤项：首项「全部」，其后「未归属」（仅当有这类错误）+ 各脚本（有日志的在前、无日志的置灰排末尾） */
interface NavItem {
  key: string
  name: string
  count: number
  hint: string
  /** 该脚本是否有日志：无日志的置灰、计数 0，提示「尚无运行记录」 */
  hasLogs: boolean
}
const navItems = computed<NavItem[]>(() => {
  const runCountByUuid = new Map<string, number>()
  const errCountByUuid = new Map<string, number>()
  const lastTimeByUuid = new Map<string, number>()
  let orphanCount = 0
  for (const row of rows.value) {
    if (row.kind === 'run') {
      runCountByUuid.set(row.uuid, (runCountByUuid.get(row.uuid) ?? 0) + 1)
      lastTimeByUuid.set(row.uuid, Math.max(lastTimeByUuid.get(row.uuid) ?? 0, row.time))
    } else {
      const u = row.record.uuid
      if (u === null) orphanCount += 1
      else {
        errCountByUuid.set(u, (errCountByUuid.get(u) ?? 0) + 1)
        lastTimeByUuid.set(u, Math.max(lastTimeByUuid.get(u) ?? 0, row.record.time))
      }
    }
  }
  // 名称：优先脚本列表（权威，含未运行脚本），日志快照兜底（已删脚本仍可读）
  const nameByUuid = new Map<string, string>()
  for (const s of scriptList.value) nameByUuid.set(s.uuid, s.name)
  for (const row of rows.value) {
    if (row.kind === 'run') {
      if (!nameByUuid.has(row.uuid)) nameByUuid.set(row.uuid, row.name || row.uuid.slice(0, 8))
    } else if (row.record.uuid) {
      if (!nameByUuid.has(row.record.uuid)) nameByUuid.set(row.record.uuid, row.record.name || row.record.uuid.slice(0, 8))
    }
  }
  // 日志里出现过的脚本（含已删但日志未清的）
  const logUuids = new Set<string>([...runCountByUuid.keys(), ...errCountByUuid.keys()])
  // 有日志的脚本：按最近活动时间倒序，排在前面
  const logItems = [...logUuids]
    .map((uuid) => ({
      key: uuid,
      name: nameByUuid.get(uuid) ?? uuid.slice(0, 8),
      count: (runCountByUuid.get(uuid) ?? 0) + (errCountByUuid.get(uuid) ?? 0),
      hint: `运行 ${runCountByUuid.get(uuid) ?? 0} 次 · 错误 ${errCountByUuid.get(uuid) ?? 0} 条`,
      hasLogs: true
    }))
    .sort((a, b) => (lastTimeByUuid.get(b.key) ?? 0) - (lastTimeByUuid.get(a.key) ?? 0))
  // 列表里有、但还没产生任何日志的脚本：置灰、计数 0，排在末尾
  const noLogItems = scriptList.value
    .filter((s) => !logUuids.has(s.uuid))
    .map<NavItem>((s) => ({
      key: s.uuid,
      name: s.name,
      count: 0,
      hint: '尚无运行记录',
      hasLogs: false
    }))
  const items: NavItem[] = [
    {
      key: ALL_KEY,
      name: '全部',
      count: rows.value.length,
      hint: '全部运行与错误混排（最新在前）',
      hasLogs: true
    }
  ]
  if (orphanCount > 0) {
    items.push({
      key: ORPHAN_KEY,
      name: '未归属',
      count: orphanCount,
      hint: '不属于任何一次运行的错误（如没能生效），单独列在这里',
      hasLogs: true
    })
  }
  return [...items, ...logItems, ...noLogItems]
})

/** 脚本 uuid → 当前已保存源码的版本时刻（ScriptSummary.savedAt），用于判断某次运行跑的是哪一版 */
const currentSavedAtByUuid = computed<Map<string, number>>(() => {
  const m = new Map<string, number>()
  for (const s of scriptList.value) m.set(s.uuid, s.savedAt)
  return m
})

/**
 * 这次运行跑的是不是「已经不是当前那一版」的源码：运行行记的 savedAt 与脚本现在已保存的版本不同。
 * 脚本已删 / 脚本列表还没拉到 / 老记录没有 savedAt —— 都无从判断，一律不提示（宁可不标，不误报）。
 */
function ranStaleSource(row: { uuid: string; savedAt?: number }): boolean {
  if (row.savedAt == null) return false
  const now = currentSavedAtByUuid.value.get(row.uuid)
  return now != null && now !== row.savedAt
}

function staleSourceHint(row: { savedAt?: number }): string {
  return `页面里跑的是 ${formatTime(row.savedAt ?? 0)} 保存的源码；脚本在那之后又被改过`
}

/** 当前选中的是某个具体脚本、且其时间线为空（只在单脚本视图下给一句空提示，全部/未归属不提示） */
const selectedScriptEmpty = computed(
  () =>
    selectedKey.value !== ALL_KEY &&
    selectedKey.value !== ORPHAN_KEY &&
    visibleRows.value.length === 0
)

/** 过滤后的时间线 */
const visibleRows = computed<UserScriptRunLogRow[]>(() => {
  if (selectedKey.value === ALL_KEY) return rows.value
  if (selectedKey.value === ORPHAN_KEY) {
    return rows.value.filter((r) => r.kind === 'error' && r.record.uuid === null)
  }
  return rows.value.filter(
    (r) => (r.kind === 'run' && r.uuid === selectedKey.value) || (r.kind === 'error' && r.record.uuid === selectedKey.value)
  )
})

const totalRuns = computed(() => rows.value.filter((r) => r.kind === 'run').length)
const totalLooseErrors = computed(() => rows.value.filter((r) => r.kind === 'error').length)

const selectedTitle = computed(() => {
  if (selectedKey.value === ALL_KEY) return `全部 · ${totalRuns.value} 次运行`
  const item = navItems.value.find((i) => i.key === selectedKey.value)
  return item ? `${item.name} · ${item.count} 条` : ''
})

/** 过滤器是否显示脚本名：全部 / 未归属视图下要（行来自不同脚本），单脚本视图下冗余 */
const showNameInRows = computed(() => selectedKey.value === ALL_KEY || selectedKey.value === ORPHAN_KEY)

/**
 * 清空参数三态（与 userscriptClient.clearErrors 的契约一一对应）：
 * undefined = 清全部；string = 清该脚本（后台连带清该脚本的运行日志条目）；
 * null = 清「未归属」错误（run-log 条目必带 uuid，此范围下 run-log 不动）。
 * 注意**不能**写 `selected.value?.uuid ?? undefined` —— null 是 nullish，
 * 那样会把「未归属」悄悄退化成「清空全部」。
 */
const clearTarget = computed<string | null | undefined>(() => {
  if (selectedKey.value === ALL_KEY) return undefined
  if (selectedKey.value === ORPHAN_KEY) return null
  return selectedKey.value
})
const clearLabel = computed(() => {
  if (selectedKey.value === ALL_KEY) return '清空全部'
  if (selectedKey.value === ORPHAN_KEY) return '清空未归属'
  return '清空该脚本'
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

function formatTime(t: number): string {
  return new Date(t).toLocaleString()
}
/** 时间线节点上的时刻：只到秒，日期在卡头已有，重复一遍是噪声 */
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
const END_REASON_LABEL: Record<RunEndReason, string> = {
  navigated: '页面导航离开',
  closed: '标签页关闭'
}
/** 结束原因文案；endedAt 在而 endReason 缺（老记录/异常写入）时给中性说法，不猜 */
function endReasonLabel(reason: RunEndReason | undefined): string {
  return reason ? END_REASON_LABEL[reason] : '结束原因未记录'
}

/** 一次运行的节点流：已拉回的事件 + 这次运行挂上的错误，按发生时刻升序混排 */
function timelineOf(events: UserScriptRunEvent[], row: RunRow): TimelineItem[] {
  const items: TimelineItem[] = events.map((e) => ({
    kind: 'event',
    time: e.time,
    label: e.kind,
    detail: e.detail
  }))
  for (const e of row.errors) {
    items.push({ kind: 'error', time: e.time, label: '', detail: '', record: e })
  }
  return items.sort((a, b) => a.time - b.time)
}

/**
 * runId → 该次运行的节点流：**只算展开态**（折叠时卡体什么都不画）。
 * 事件靠展开触发的按需拉取，还没拉回来就只显示错误节点。
 */
const timelineByRunId = computed<Map<string, TimelineItem[]>>(() => {
  const expanded = expandedRunIds.value
  const loaded = eventsByRunId.value
  const m = new Map<string, TimelineItem[]>()
  for (const r of rows.value) {
    if (r.kind !== 'run' || !expanded.has(r.runId)) continue
    m.set(r.runId, timelineOf(loaded.get(r.runId) ?? [], r))
  }
  return m
})

/** 已拉回的事件条数（与运行条目的 eventCount 比对，得出「还有多少条没显示」） */
function loadedEventCount(runId: string): number {
  return eventsByRunId.value.get(runId)?.length ?? 0
}

/** 没显示出来的事件条数：eventCount 是收到总数，落盘条数受 RUN_EVENT_MAX 封顶 */
function omittedEventCount(row: RunRow): number {
  return Math.max(0, (row.eventCount ?? 0) - loadedEventCount(row.runId))
}
/** 错误 ID 展示短形态（前 8 位；复制按钮复制完整 id，供 AI 代查）。容忍 undefined：时间线节点上取 record 是可选的 */
function shortErrorId(id: string | undefined): string {
  return id ? id.slice(0, 8) : ''
}
const copiedErrorId = ref('')
async function copyErrorId(id: string | undefined): Promise<void> {
  if (!id) return
  try {
    await navigator.clipboard.writeText(id)
    copiedErrorId.value = id
    window.setTimeout(() => (copiedErrorId.value = ''), 1500)
  } catch (e) {
    error.value = '复制失败：' + (e instanceof Error ? e.message : String(e))
  }
}

/**
 * 展开 / 折叠一次运行：展开时按 runId 拉那一组事件（懒加载，拉过就缓存）。
 * 列表视图不带事件——事件单独一表，跟随运行数全量读会线性膨胀，看哪一次才拉哪一次。
 */
async function toggleExpand(row: RunRow): Promise<void> {
  const runId = row.runId
  const next = new Set(expandedRunIds.value)
  if (next.has(runId)) {
    next.delete(runId)
    expandedRunIds.value = next
    return
  }
  next.add(runId)
  expandedRunIds.value = next
  // 没有动作的运行（eventCount 缺省 / 为 0）只有错误可看，不必拉事件
  if (!row.eventCount || eventsByRunId.value.has(runId)) return
  loadingRunIds.value = new Set(loadingRunIds.value).add(runId)
  try {
    const events = await userscriptClient.runEvents(runId)
    const cached = new Map(eventsByRunId.value)
    cached.set(runId, events)
    eventsByRunId.value = cached
  } catch (e) {
    error.value = '拉取运行动作失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    const busy = new Set(loadingRunIds.value)
    busy.delete(runId)
    loadingRunIds.value = busy
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [logRows, scripts] = await Promise.all([
      userscriptClient.runlog(),
      userscriptClient.list()
    ])
    rows.value = logRows
    scriptList.value = scripts
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

/** 脚本 uuid → 名称。取不到就退回短 uuid（说明一句目标是谁，不为了名字让提示消失） */
async function nameOf(uuid: string): Promise<string> {
  try {
    const list = await userscriptClient.list()
    return list.find((s) => s.uuid === uuid)?.name ?? uuid.slice(0, 8)
  } catch {
    return uuid.slice(0, 8)
  }
}

/**
 * 重拉后的收尾：正在看的分组已经不存在（被清空 / 脚本被删）时回落「全部」。
 * 不做这一步会停在空视图上 —— 标题为空、时间线空白，像是页面坏了。
 */
function fallbackSelectionIfGone(): void {
  if (selectedKey.value !== ALL_KEY && !navItems.value.some((i) => i.key === selectedKey.value)) {
    selectedKey.value = ALL_KEY
  }
}

/** 清空当前视图：按 clearTarget 的三态决定范围，清完重新拉取并把消失的分组回落「全部」 */
async function onClear(): Promise<void> {
  try {
    await userscriptClient.clearErrors(clearTarget.value)
    expandedRunIds.value = new Set()
    eventsByRunId.value = new Map()
    await load()
    fallbackSelectionIfGone()
  } catch (e) {
    error.value = '清空失败：' + (e instanceof Error ? e.message : String(e))
  }
}

// 深链定位：宿主传入 focusUuid 时过滤该脚本；该脚本当前没有记录则落「全部」并说明一句。
// immediate + watch 而非只 onMounted：工作台标签页常驻（unmount-on-hide=false），
// 同一页面内灵动岛再次跳转会只改 prop、不重挂组件，必须靠 watch 接住；
// focusSeq 一并监听，保证「对同一脚本再点一次」也重新定位 + 拉最新。
watch(
  [() => props.focusUuid, () => props.focusSeq],
  async ([uuid]) => {
    if (!uuid) return
    await load()
    const hit = navItems.value.find((i) => i.key === uuid)
    if (hit) {
      selectedKey.value = uuid
      focusMissName.value = ''
      return
    }
    selectedKey.value = ALL_KEY
    focusMissName.value = await nameOf(uuid)
  },
  { immediate: true }
)

// 宿主请求重拉（脚本被删除后递增 reloadSeq）：该脚本的记录已随删除在后台清掉，
// 但本标签页常驻不重挂，不重拉就还显示着它的旧内容。
watch(
  () => props.reloadSeq,
  async () => {
    await load()
    fallbackSelectionIfGone()
  }
)

// 写侧落盘后已广播 `runstats`（运行统计/日志）与 `error`（错误 append/清空）两个域，
// 这里都接住自动回拉，不必等手动刷新；正看的分组消失时按既有逻辑回落「全部」
useDataSync('runstats', async () => {
  await load()
  fallbackSelectionIfGone()
})
useDataSync('error', async () => {
  await load()
  fallbackSelectionIfGone()
})

onMounted(() => {
  // 带深链进来时 watch 已负责首次加载，避免重复拉一次
  if (!props.focusUuid) void load()
})
</script>

<template>
  <!-- 根用 h-full 而非 flex-1：宿主 ui-tabs-content 不是 flex 容器，flex-1 撑不开高度 -->
  <div class="flex h-full min-h-0 flex-col">
    <!-- 头部：说明 + 概览 + 刷新 -->
    <div class="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
      <ui-history class="size-4 text-muted-foreground" />
      <span class="text-sm font-medium">运行日志</span>
      <span class="text-xs text-muted-foreground">
        共 {{ totalRuns }} 次运行<template v-if="totalLooseErrors"> · {{ totalLooseErrors }} 条无法归属的错误</template> · 保留最近 {{ RUN_LOG_MAX }} 条
      </span>
      <span class="flex-1" />
      <ui-button
        variant="ghost"
        size="sm"
        class="h-7 gap-1 px-2.5 text-xs"
        title="重新拉取运行日志"
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

    <!-- 深链目标当前无记录：说明一句，而不是让用户对着「全部」猜 -->
    <p
      v-if="focusMissName"
      class="mx-4 mt-3 shrink-0 rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground"
    >
      脚本「{{ focusMissName }}」当前没有运行记录，已切到全部。
    </p>

    <!-- 双栏常驻：即便一条日志都没有，左栏脚本列表也要可见（可看有哪些脚本、逐个选中看空提示） -->
    <div class="flex min-h-0 flex-1">
      <!-- 左栏：脚本过滤（条数徽标，hover 看运行/错误拆解） -->
      <nav class="w-56 shrink-0 overflow-y-auto border-r border-border py-2" aria-label="按脚本过滤">
        <button
          v-for="item in navItems"
          :key="item.key"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted"
          :class="[
            item.key === selectedKey
              ? 'bg-muted font-medium text-foreground'
              : 'text-muted-foreground',
            !item.hasLogs ? 'opacity-50' : ''
          ]"
          :title="item.hint"
          @click="selectedKey = item.key"
        >
          <span class="min-w-0 flex-1 truncate">{{ item.name }}</span>
          <ui-badge variant="secondary" class="h-4 px-1.5 text-[10px]">{{ item.count }}</ui-badge>
        </button>
      </nav>

      <!-- 右栏：时间线（最新在前） -->
      <div class="min-w-0 flex-1 overflow-y-auto">
        <div class="mx-auto max-w-3xl p-4">
          <header class="flex items-center justify-between gap-2">
            <p class="text-xs text-muted-foreground">{{ selectedTitle }}（最新在前）</p>
            <ui-button
              variant="ghost"
              size="sm"
              class="h-6 gap-1 px-2 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="立即从存储删除，不可撤销；只影响当前选中的范围"
              @click="onClear"
            >
              <ui-trash-2 class="size-3" />
              {{ clearLabel }}
            </ui-button>
          </header>

          <p
            v-if="!rows.length"
            class="mt-3 flex flex-col gap-1.5 rounded-md border bg-card px-3 py-3 text-xs text-muted-foreground"
          >
            <span class="flex items-center gap-1.5">
              <ui-history class="size-3.5" />
              {{ loading ? '加载中…' : '暂无运行记录。' }}
            </span>
            <span v-if="!loading">
              启用脚本并访问命中页面后，每次运行都会按时间记在这里；运行期报错挂在对应运行下，没能生效等不属于任何一次运行的错误单独成行。
            </span>
          </p>

          <p
            v-else-if="selectedScriptEmpty"
            class="mt-3 rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground"
          >
            脚本「{{ navItems.find((i) => i.key === selectedKey)?.name }}」暂未运行。启用并访问命中的页面后，每次运行都会记在这里。
          </p>

          <ul v-if="rows.length" class="run-log-timeline mt-2 flex flex-col gap-2">
            <li v-for="row in visibleRows" :key="row.kind === 'run' ? row.runId : row.record.id">
              <!-- 运行行：一次页面加载一条，出错可展开明细 -->
              <div v-if="row.kind === 'run'" class="rounded-md border bg-card p-3 text-xs">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    运行
                  </span>
                  <!-- 跑的源码已不是当前这一版：只有比对得出「不一致」时才标，一致时不必占位 -->
                  <span
                    v-if="ranStaleSource(row)"
                    class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                    :title="staleSourceHint(row)"
                  >
                    旧版源码
                  </span>
                  <span v-if="showNameInRows" class="truncate font-medium">{{ row.name || row.uuid.slice(0, 8) }}</span>
                  <span class="text-muted-foreground">{{ formatTime(row.time) }}</span>
                  <span
                    v-if="row.errors.length"
                    class="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
                  >
                    {{ row.errors.length }} 个错误
                  </span>
                  <!-- 只陈述「没挂错误」这一事实：运行日志没有结束状态，「正常结束」会暗示脚本跑完了 -->
                  <span
                    v-else
                    class="text-[10px] text-muted-foreground"
                    :title="`这次运行没有报错（runId：${row.runId}）`"
                  >
                    无错误
                  </span>
                  <!-- 动作数取自运行条目上的 eventCount：事件本体要展开才拉，这里只报个数 -->
                  <span v-if="row.eventCount" class="text-[10px] text-muted-foreground">
                    {{ row.eventCount }} 个动作
                  </span>
                  <!-- 展开入口：有动作或错误才有内容可看；动作在这一刻才按需拉 -->
                  <button
                    v-if="row.errors.length || row.eventCount"
                    type="button"
                    class="rounded border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted"
                    :title="
                      expandedRunIds.has(row.runId)
                        ? '收起这次运行做过的事与报的错'
                        : '展开这次运行做过的事与报的错'
                    "
                    @click="toggleExpand(row)"
                  >
                    {{ expandedRunIds.has(row.runId) ? '收起' : '展开' }}
                  </button>
                </div>
                <!-- 运行所在页面：与错误行的 url 同一形态（单行截断，hover 看全量）；老记录没有则不渲染 -->
                <p v-if="row.url" class="mt-1 truncate text-muted-foreground" :title="row.url">
                  {{ row.url }}
                </p>
                <!-- 展开才拉动作：给一句加载态，避免「点了没反应」 -->
                <p
                  v-if="expandedRunIds.has(row.runId) && loadingRunIds.has(row.runId)"
                  class="mt-2 text-[10px] text-muted-foreground"
                >
                  加载动作…
                </p>
                <!-- 运行时间线：脚本过桥做过的事（事件）与报的错按时刻混排 -->
                <ul
                  v-else-if="timelineByRunId.get(row.runId)?.length"
                  class="mt-2 flex flex-col gap-1.5"
                >
                  <li
                    v-for="(item, i) in timelineByRunId.get(row.runId) ?? []"
                    :key="i"
                    class="flex items-start gap-1.5"
                  >
                    <!-- 事件节点：灰点 + 时刻 + 命令名 + 一行摘要（摘要已脱敏，可安全展示） -->
                    <template v-if="item.kind === 'event'">
                      <span class="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                      <span class="shrink-0 tabular-nums text-muted-foreground">
                        {{ formatClock(item.time) }}
                      </span>
                      <span class="shrink-0 font-mono text-muted-foreground">{{ item.label }}</span>
                      <span class="min-w-0 flex-1 truncate" :title="item.detail">{{ item.detail }}</span>
                    </template>
                    <!-- 错误节点：红色点 + 时刻 + message，附可复制 ID 与栈 -->
                    <template v-else>
                      <span class="mt-1.5 size-1.5 shrink-0 rounded-full bg-destructive" />
                      <span class="shrink-0 tabular-nums text-muted-foreground">
                        {{ formatClock(item.time) }}
                      </span>
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-start gap-1.5">
                          <span class="min-w-0 flex-1 break-all text-destructive">
                            {{ item.record?.message }}
                          </span>
                          <button
                            type="button"
                            class="flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted"
                            :title="`复制完整错误 ID（发给 AI 可自动查询修复）：${item.record?.id}`"
                            @click="copyErrorId(item.record?.id)"
                          >
                            <ui-check
                              v-if="copiedErrorId === item.record?.id"
                              class="size-3 text-green-600"
                            />
                            <ui-copy v-else class="size-3" />
                            {{ shortErrorId(item.record?.id) }}
                          </button>
                        </div>
                        <p
                          v-if="item.record?.url"
                          class="truncate text-muted-foreground"
                          :title="item.record.url"
                        >
                          {{ item.record.url }}
                        </p>
                        <pre
                          v-if="item.record?.stack"
                          class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-[11px] leading-relaxed"
                        >{{ item.record.stack }}</pre>
                      </div>
                    </template>
                  </li>
                </ul>
                <!-- 事件被上限截掉时说明一句：eventCount 是收到总数，落盘条数封顶 -->
                <p
                  v-if="expandedRunIds.has(row.runId) && omittedEventCount(row)"
                  class="mt-1.5 text-[10px] text-muted-foreground"
                >
                  还有 {{ omittedEventCount(row) }} 个动作已省略（超过单次运行上限）
                </p>
                <!-- 结束节点：只有真收到结束信号才画——老记录与仍在跑的都没有 endedAt，一律沉默，不臆断「结束了」 -->
                <p
                  v-if="row.endedAt"
                  class="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2 text-[10px] text-muted-foreground"
                >
                  <span class="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                  <span>
                    已结束 · {{ endReasonLabel(row.endReason) }} · 存活
                    {{ formatDuration(row.endedAt - row.time) }}
                  </span>
                </p>
              </div>

              <!-- 孤儿错误行：无运行上下文（注册/桥失败）或所属运行已滑出环形 -->
              <div v-else class="rounded-md border bg-card p-3 text-xs">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span
                    :class="phaseBadgeClass(row.record.phase)"
                    class="rounded px-1.5 py-0.5 text-[10px] font-medium"
                  >
                    {{ phaseLabel(row.record.phase) }}
                  </span>
                  <span v-if="showNameInRows" class="truncate font-medium">{{ row.record.name }}</span>
                  <span class="text-muted-foreground">{{ formatTime(row.record.time) }}</span>
                  <button
                    type="button"
                    class="ml-auto flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted"
                    :title="`复制完整错误 ID（发给 AI 可自动查询修复）：${row.record.id}`"
                    @click="copyErrorId(row.record.id)"
                  >
                    <ui-check v-if="copiedErrorId === row.record.id" class="size-3 text-green-600" />
                    <ui-copy v-else class="size-3" />
                    {{ shortErrorId(row.record.id) }}
                  </button>
                </div>
                <p class="mt-1 break-all text-destructive">{{ row.record.message }}</p>
                <p v-if="row.record.url" class="mt-0.5 truncate text-muted-foreground" :title="row.record.url">
                  {{ row.record.url }}
                </p>
                <pre
                  v-if="row.record.stack"
                  class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-[11px] leading-relaxed"
                >{{ row.record.stack }}</pre>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
