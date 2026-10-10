<script setup lang="ts">
// 「接口数据」标签页：录制到的页面接口流量（IndexedDB duoling-netlog）的浏览与清理。
//
// 动机：录制是给 AI 用的（net_capture_read 读回语料），但录下来的是什么、录了哪些站点，
// 人看不到 —— 也不知道它在不在录。本面板补这半边：左栏站点，右栏按**录制会话**分节、
// 节内一条请求一行，顶部给正在录制的标签页一处就地停下的地方。
//
// 读走 netlog-db 直连 IndexedDB（与「会话数据」同款姿势，工作台是扩展页同源可读）；
// **写（清空）与启停走命令面** —— netlog 的单写方是 SW，门禁在 SW 侧维护，面板不越界。
//
// 不接 useDataSync：netlog 的写频随页面请求走（每秒级都可能写），为它广播会把一条通知通道
// 变成噪音源；录制状态的变化（开着 / 停了）另有刷新按钮兜住。
import { computed, onMounted, ref } from 'vue'
import { Radio as UiRadio, RefreshCw as UiRefreshCw, Trash2 as UiTrash2 } from '@lucide/vue'
import { Badge as UiBadge } from '@/components/ui/badge'
import { Button as UiButton } from '@/components/ui/button'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import {
  Collapsible as UiCollapsible,
  CollapsibleContent as UiCollapsibleContent,
  CollapsibleTrigger as UiCollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger,
} from '@/components/ui/tooltip'
import { routeOf } from '@/lib/userscripts/net-record-digest'
import {
  countCapturesByHost,
  listCapturedHosts,
  listCapturesByHost,
  listSessionHosts,
  listSessionsByHost,
} from '@/lib/userscripts/netlog-db'
import { userscriptClient } from '@/lib/userscripts/ui-client'
import type { NetCaptureRecord, NetRecordSession } from '@/lib/userscripts/net-record-protocol'

/** 一个录制会话分节；未匹配到归档会话的采样挂在 session 为 null 的那一节。节内一条请求一行，不聚合 */
interface SessionGroup {
  id: string
  session: NetRecordSession | null
  records: NetCaptureRecord[]
}

const loading = ref(false)
const error = ref('')

/** 有数据的站点（记录或归档会话任一命中即上榜：录到 0 条请求的会话也该有一行） */
const hosts = ref<string[]>([])
/** 各站点的记录条数（左栏展示） */
const counts = ref<Record<string, number>>({})
/** 正在录制的会话（SW 为权威） */
const recording = ref<NetRecordSession[]>([])

const selectedHost = ref('')
const records = ref<NetCaptureRecord[]>([])
const sessions = ref<NetRecordSession[]>([])
const hostLoading = ref(false)

/** 清空确认弹窗的显隐（破坏性操作，先问再清） */
const clearOpen = ref(false)
/** 停止录制在途（按钮禁用，防连点重复发命令） */
const stoppingTabId = ref<number | null>(null)

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [captured, sessionHosts, state] = await Promise.all([
      listCapturedHosts(),
      listSessionHosts(),
      userscriptClient.netCaptureState(),
    ])
    const merged: string[] = []
    for (const h of [...captured, ...sessionHosts]) if (!merged.includes(h)) merged.push(h)
    merged.sort()
    hosts.value = merged
    recording.value = state.sessions
    const nextCounts: Record<string, number> = {}
    await Promise.all(merged.map(async (h) => (nextCounts[h] = await countCapturesByHost(h))))
    counts.value = nextCounts
    // 选中的站点被清空后要从左栏消失：落到第一个可用站点，没有就清空右栏
    if (!selectedHost.value || !merged.includes(selectedHost.value)) {
      selectedHost.value = merged[0] ?? ''
    }
    await loadHost(selectedHost.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadHost(host: string): Promise<void> {
  records.value = []
  sessions.value = []
  if (!host) return
  hostLoading.value = true
  error.value = ''
  try {
    const [recs, sess] = await Promise.all([listCapturesByHost(host), listSessionsByHost(host)])
    records.value = recs
    sessions.value = sess
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    hostLoading.value = false
  }
}

function selectHost(host: string): void {
  if (host === selectedHost.value) return
  selectedHost.value = host
  void loadHost(host)
}

onMounted(() => void refresh())

/**
 * 按录制会话分节，节内**一条请求一行**（不按接口聚合）。
 * 会话按开始时刻倒序（最近一次录的最相关）；找不到归档会话的采样单独一节垫底 ——
 * 归档是会话结束后的另一步，中间崩一下就会留下这种记录，丢掉不如照样列出来。
 */
const groups = computed<SessionGroup[]>(() => {
  const byId = new Map(sessions.value.map((s) => [s.id, s]))
  const buckets = new Map<string, NetCaptureRecord[]>()
  for (const r of records.value) {
    const list = buckets.get(r.sessionId)
    if (list) list.push(r)
    else buckets.set(r.sessionId, [r])
  }
  const out: SessionGroup[] = []
  for (const [id, recs] of buckets) {
    out.push({ id, session: byId.get(id) ?? null, records: recs })
  }
  return out.sort((a, b) => {
    if (!a.session) return 1
    if (!b.session) return -1
    return b.session.startedAt - a.session.startedAt
  })
})

/** 展开的请求行（key = 会话 id + 记录 id，跨会话不串） */
const openRows = ref(new Set<string>())
function toggleRow(key: string): void {
  const next = new Set(openRows.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  openRows.value = next
}

/** 该站点是否正在录制（左栏圆点 / 清空按钮的禁用依据） */
function isRecording(host: string): boolean {
  return recording.value.some((s) => s.host === host)
}

/** 停掉某个标签页的录制（会话结束、已录内容保留） */
async function stopTab(tabId: number): Promise<void> {
  if (stoppingTabId.value != null) return
  stoppingTabId.value = tabId
  error.value = ''
  try {
    await userscriptClient.netCaptureDisable(tabId)
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    stoppingTabId.value = null
  }
}

/** 清空选中站点的全部录制数据（记录 + 会话归档） */
async function clearSelectedHost(): Promise<void> {
  const host = selectedHost.value
  if (!host) return
  error.value = ''
  try {
    await userscriptClient.netLogClear(host)
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

// —— 展示辅助 ——

function formatStamp(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 会话标题（录入时为空的退化到「从地址取路径」） */
function sessionLabel(g: SessionGroup): string {
  const title = g.session?.title?.trim()
  if (title) return title
  const url = g.session?.url ?? g.records[0]?.url ?? ''
  try {
    const u = new URL(url)
    return u.pathname === '/' ? u.host : u.pathname
  } catch {
    return '未归档的采样'
  }
}

function sessionMeta(g: SessionGroup): string {
  if (!g.session) return `${g.records.length} 条 · 无会话记录`
  const ended = g.session.endedAt ? '已结束' : '进行中'
  return `${formatStamp(g.session.startedAt)} · ${ended} · ${g.records.length} 条`
}

function headerText(h: Record<string, string>): string {
  return Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0" data-testid="net-log-panel">
    <!-- 左栏：录到过数据的站点 -->
    <aside class="flex min-h-0 w-72 shrink-0 flex-col border-r border-border">
      <header class="flex items-center justify-between border-b border-border px-3 py-2">
        <div class="flex items-center gap-1.5 text-sm font-medium">
          <ui-radio class="size-4 text-muted-foreground" />
          站点（{{ hosts.length }}）
        </div>
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <button
                type="button"
                class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                :disabled="loading"
                aria-label="重新读取"
                data-testid="net-log-refresh"
                @click="refresh()"
              >
                <ui-refresh-cw class="size-4" :class="{ 'animate-spin': loading }" />
              </button>
            </ui-tooltip-trigger>
            <ui-tooltip-content>重新读取</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
        <p
          v-if="!loading && !hosts.length"
          class="px-2 py-4 text-center text-xs text-muted-foreground"
          data-testid="net-log-empty"
        >
          还没有录到任何接口
        </p>
        <button
          v-for="h in hosts"
          :key="h"
          type="button"
          class="mb-1 w-full rounded-md px-2 py-1.5 text-left transition-colors"
          :class="h === selectedHost ? 'bg-muted' : 'hover:bg-muted/60'"
          :data-testid="`net-log-site-${h}`"
          @click="selectHost(h)"
        >
          <span class="flex items-center gap-1.5">
            <span
              v-if="isRecording(h)"
              class="size-1.5 shrink-0 rounded-full bg-primary"
              aria-label="正在录制"
            />
            <span class="min-w-0 flex-1 truncate text-sm" :title="h">{{ h }}</span>
          </span>
          <span class="mt-0.5 block text-xs text-muted-foreground tabular-nums">
            {{ counts[h] ?? 0 }} 条
          </span>
        </button>
      </div>
    </aside>

    <!-- 右栏：选中站点的录制会话与接口清单 -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <header class="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-sm">
        <span class="min-w-0 truncate text-muted-foreground">
          {{ selectedHost || '左侧选择一个站点' }}
        </span>
        <ui-button
          v-if="selectedHost"
          variant="outline"
          size="sm"
          class="h-7 shrink-0 px-2 text-xs"
          :disabled="!records.length"
          data-testid="net-log-clear"
          @click="clearOpen = true"
        >
          <ui-trash2 class="size-3.5" />
          清空该站点
        </ui-button>
      </header>

      <p
        v-if="error"
        class="m-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
        role="alert"
        data-testid="net-log-error"
      >
        {{ error }}
      </p>

      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <!-- 正在录制：开关在浮层的同意卡上，这里只给「此刻在录哪些标签页」与就地停下 -->
        <div
          v-if="recording.length"
          class="rounded-lg border border-border bg-card"
          data-testid="net-log-recording"
        >
          <div class="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs">
            <span class="size-1.5 rounded-full bg-primary" />
            <span class="font-medium">正在录制（{{ recording.length }}）</span>
          </div>
          <div
            v-for="s in recording"
            :key="s.id"
            class="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 last:border-b-0"
            :data-testid="`net-log-recording-${s.tabId}`"
          >
            <span class="min-w-0 flex-1 truncate text-xs" :title="s.url">
              {{ s.host }}<template v-if="s.title"> · {{ s.title }}</template>
            </span>
            <span class="shrink-0 text-xs text-muted-foreground tabular-nums">
              {{ formatStamp(s.startedAt) }}
            </span>
            <ui-button
              variant="outline"
              size="sm"
              class="h-6 shrink-0 px-2 text-xs"
              :disabled="stoppingTabId === s.tabId"
              title="停止这个标签页的录制；已录到的内容保留"
              @click="stopTab(s.tabId)"
            >
              停止
            </ui-button>
          </div>
        </div>

        <p v-if="hostLoading" class="text-xs text-muted-foreground">读取中…</p>
        <p
          v-else-if="selectedHost && !records.length"
          class="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground"
        >
          该站点还没有录到请求
        </p>

        <!-- 每个录制会话一节；节内一条请求一行（不聚合），展开看采样明细 -->
        <section
          v-for="g in selectedHost ? groups : []"
          :key="g.id"
          class="rounded-lg border border-border bg-card"
          :data-testid="`net-log-session-${g.id}`"
        >
          <header class="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
            <span class="min-w-0 flex-1 truncate text-sm font-medium" :title="g.session?.url">
              {{ sessionLabel(g) }}
            </span>
            <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ sessionMeta(g) }}</span>
          </header>
          <div class="p-2">
            <ui-collapsible
              v-for="rec in g.records"
              :key="`${g.id}-${rec.id}`"
              :open="openRows.has(`${g.id}-${rec.id}`)"
              class="mb-1.5 rounded-md border border-border last:mb-0"
              :data-testid="`net-log-record-${rec.id}`"
              @update:open="toggleRow(`${g.id}-${rec.id}`)"
            >
              <ui-collapsible-trigger
                class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/40"
              >
                <span class="shrink-0 font-mono text-xs font-medium">{{ rec.method }}</span>
                <span
                  class="min-w-0 flex-1 truncate font-mono text-xs"
                  :title="rec.url"
                >
                  {{ routeOf(rec.url) }}
                </span>
                <span class="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {{ formatStamp(rec.t) }}
                </span>
                <ui-badge
                  v-if="rec.status"
                  :variant="rec.status >= 400 ? 'destructive' : 'secondary'"
                  class="shrink-0 text-[10px] tabular-nums"
                >
                  {{ rec.status }}
                </ui-badge>
              </ui-collapsible-trigger>
              <ui-collapsible-content class="overflow-hidden">
                <div class="border-t border-border/60 px-2.5 py-2 text-xs">
                  <p class="font-mono text-[11px] leading-relaxed break-all">
                    {{ rec.url }}（{{ rec.type }}）
                  </p>
                  <template v-if="Object.keys(rec.reqHeaders).length">
                    <h4 class="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      请求头
                    </h4>
                    <pre class="mt-0.5 max-h-40 overflow-auto rounded bg-muted/50 p-1.5 font-mono text-[11px] leading-relaxed">{{ headerText(rec.reqHeaders) }}</pre>
                  </template>
                  <template v-if="rec.reqBody">
                    <h4 class="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      请求体
                    </h4>
                    <pre class="mt-0.5 max-h-40 overflow-auto rounded bg-muted/50 p-1.5 font-mono text-[11px] leading-relaxed">{{ rec.reqBody }}</pre>
                  </template>
                  <template v-if="Object.keys(rec.respHeaders).length">
                    <h4 class="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      响应头
                    </h4>
                    <pre class="mt-0.5 max-h-40 overflow-auto rounded bg-muted/50 p-1.5 font-mono text-[11px] leading-relaxed">{{ headerText(rec.respHeaders) }}</pre>
                  </template>
                  <template v-if="rec.respBody">
                    <h4 class="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      响应结构
                    </h4>
                    <pre class="mt-0.5 max-h-40 overflow-auto rounded bg-muted/50 p-1.5 font-mono text-[11px] leading-relaxed">{{ rec.respBody }}</pre>
                  </template>
                </div>
              </ui-collapsible-content>
            </ui-collapsible>
          </div>
        </section>
      </div>
    </div>

    <ConfirmDialog
      v-model:open="clearOpen"
      danger
      title="清空该站点的录制数据"
      :description="`将删除 ${selectedHost} 的全部接口采样与录制会话记录，删除后无法恢复。`"
      confirm-text="清空"
      @confirm="clearSelectedHost"
    />
  </section>
</template>
