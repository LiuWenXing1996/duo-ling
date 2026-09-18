<script setup lang="ts">
// 错误日志标签页：用户脚本三类错误（运行期 / 注册 / DL 桥）的**按脚本分类**视图。
//
// 独立成页（列表页只留入口按钮）的理由：错误一多折叠面板就不够用，且「按脚本找」与「按时间
// 看」是两条不同动线 —— 独立页才有横向空间做「左脚本清单 + 右错误明细」的主从布局。
//
// 数据通道：userscriptClient（workbench 是可信扩展页，可直接 chrome.runtime.sendMessage，
// 不走 window.api —— 那是给平移来的桌面版 UI 组件用的 PreloadApi 契约）。
import { computed, onMounted, ref, watch } from 'vue'
import { useDataSync } from '@/composables/use-data-sync'
import {
  AlertTriangle as UiAlertTriangle,
  Check as UiCheck,
  Copy as UiCopy,
  RefreshCw as UiRefreshCw,
  Trash2 as UiTrash2
} from '@lucide/vue'
import { Badge as UiBadge } from '@/components/ui/badge'
import { Button as UiButton } from '@/components/ui/button'
import { userscriptClient } from '@/lib/userscripts/ui-client'
import { ERROR_LOG_MAX, type UserScriptErrorRecord } from '@/lib/userscripts/types'

/** 深链定位：浮窗「点击脚本行」→ workbench.html#/errors/<uuid> → 宿主传入。
 *  带 focusSeq（宿主每次定位请求递增）：标签页常驻不重挂，对同一脚本再点一次时
 *  focusUuid 不变，只靠 uuid 无法触发 watch —— seq 是「这次请求」的标识。
 *  reloadSeq 同理由宿主递增（脚本被删除后要求重拉），见文件末 watch。 */
const props = defineProps<{ focusUuid?: string | null; focusSeq?: number; reloadSeq?: number }>()

/** 「全部」伪分组 key：不是一个真实脚本，仅表示「按时间看全部」 */
const ALL_KEY = '__all__'
/** 「未归属」分组 key：uuid 为 null 的记录（注册失败无脚本上下文、部分桥错误）。
 *  这类记录合并成一组而非按 name 各分一组 —— 它们是杂项，左栏不该被它们占满。 */
const ORPHAN_KEY = '__orphan__'

const errors = ref<UserScriptErrorRecord[]>([])
const loading = ref(false)
const error = ref('')
/** 当前选中分组 key（默认「全部」） */
const selectedKey = ref<string>(ALL_KEY)
/** 深链目标在当前日志里不存在时的说明（否则用户只看到「点了没反应」） */
const focusMissName = ref('')

/** 一个左栏分组 = 一个脚本（或「未归属」）的全部错误 */
interface ErrorGroup {
  key: string
  /** null = 未归属组 */
  uuid: string | null
  name: string
  /** 该脚本的错误，沿用 listUserScriptErrors 的顺序（最新在前） */
  items: UserScriptErrorRecord[]
  /** 最近一条错误的时刻，用于左栏排序 */
  latest: number
}

/**
 * 按脚本分组。有 uuid 的按 uuid 归组（同一脚本历次运行的错误聚在一起），
 * uuid 为 null 的全部并入「未归属」组。
 * 排序：有 uuid 的组按最近错误时间倒序（刚崩的在最上）；「未归属」是杂项，恒排最后。
 */
const groups = computed<ErrorGroup[]>(() => {
  const byKey = new Map<string, ErrorGroup>()
  for (const e of errors.value) {
    const key = e.uuid ?? ORPHAN_KEY
    let g = byKey.get(key)
    if (!g) {
      g = { key, uuid: e.uuid, name: e.uuid ? e.name : '未归属', items: [], latest: 0 }
      byKey.set(key, g)
    }
    g.items.push(e)
    // 记录最新在前，首条即该组最新时刻
    if (!g.latest) g.latest = e.time
  }
  const named = [...byKey.values()].filter((g) => g.uuid !== null).sort((a, b) => b.latest - a.latest)
  const orphan = byKey.get(ORPHAN_KEY)
  return orphan ? [...named, orphan] : named
})

/** 左栏项：首项固定「全部错误」，其后是各脚本分组 */
interface NavItem {
  key: string
  name: string
  count: number
  /** hover 提示：分组内各阶段错误数拆解（左栏窄，细节放 title 里） */
  hint: string
}
const navItems = computed<NavItem[]>(() => [
  {
    key: ALL_KEY,
    name: '全部错误',
    count: errors.value.length,
    hint: '所有脚本的错误混排（最新在前）'
  },
  ...groups.value.map((g) => ({
    key: g.key,
    name: g.name,
    count: g.items.length,
    hint:
      g.uuid === null
        ? `没有脚本上下文的错误（注册失败 / 部分桥错误）· ${phaseBreakdown(g.items)}`
        : phaseBreakdown(g.items)
  }))
])

/** 当前选中分组；null = 选中的是「全部」伪分组（或分组已不存在） */
const selected = computed(() => groups.value.find((g) => g.key === selectedKey.value) ?? null)

const visibleErrors = computed(() =>
  selectedKey.value === ALL_KEY ? errors.value : (selected.value?.items ?? [])
)

/** 明细卡片是否显示脚本名：全部 / 未归属视图下要（卡片来自不同脚本），单脚本视图下冗余 */
const showNameInCards = computed(() => selectedKey.value === ALL_KEY || selected.value?.uuid === null)

const selectedTitle = computed(() => {
  if (selectedKey.value === ALL_KEY) return `全部错误 · ${errors.value.length} 条`
  return selected.value ? `${selected.value.name} · ${selected.value.items.length} 条` : ''
})

/**
 * 清空参数三态（与 userscriptClient.clearErrors 的契约一一对应）：
 * undefined = 清全部；string = 清该脚本；null = 清「未归属」记录。
 * 注意**不能**写 `selected.value?.uuid ?? undefined` —— null 是 nullish，
 * 那样会把「未归属」悄悄退化成「清空全部」（本组件最容易出的一类错）。
 */
const clearTarget = computed<string | null | undefined>(() => {
  if (selectedKey.value === ALL_KEY) return undefined
  const g = selected.value
  if (!g) return undefined
  return g.uuid
})
const clearLabel = computed(() => {
  if (selectedKey.value === ALL_KEY) return '清空全部'
  return selected.value?.uuid === null ? '清空未归属' : '清空该脚本'
})

const PHASE_LABEL: Record<UserScriptErrorRecord['phase'], string> = {
  runtime: '运行期',
  register: '注册',
  bridge: 'DL 桥'
}
/** 阶段配色走语义 token（不硬编码色值、不手写 dark: 覆盖）：运行期最需要关注 → destructive */
const PHASE_BADGE: Record<UserScriptErrorRecord['phase'], string> = {
  runtime: 'bg-destructive/10 text-destructive',
  register: 'bg-muted text-muted-foreground',
  bridge: 'bg-primary/10 text-primary'
}
function phaseLabel(p: UserScriptErrorRecord['phase']): string {
  return PHASE_LABEL[p]
}
function phaseBadgeClass(p: UserScriptErrorRecord['phase']): string {
  return PHASE_BADGE[p]
}
/** 分组提示文案：只列非零阶段，如「运行期 3 · 注册 1」 */
function phaseBreakdown(items: UserScriptErrorRecord[]): string {
  return (Object.keys(PHASE_LABEL) as UserScriptErrorRecord['phase'][])
    .map((p) => ({ p, n: items.filter((e) => e.phase === p).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${PHASE_LABEL[x.p]} ${x.n}`)
    .join(' · ')
}

function formatTime(t: number): string {
  return new Date(t).toLocaleString()
}
/** 错误 ID 展示短形态（前 8 位；复制按钮复制完整 id，供 AI 代查） */
function shortErrorId(id: string): string {
  return id.slice(0, 8)
}
const copiedErrorId = ref('')
async function copyErrorId(id: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(id)
    copiedErrorId.value = id
    window.setTimeout(() => (copiedErrorId.value = ''), 1500)
  } catch (e) {
    error.value = '复制失败：' + (e instanceof Error ? e.message : String(e))
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    errors.value = await userscriptClient.errors()
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
 * 不做这一步会停在空视图上 —— 标题为空、明细区空白，像是页面坏了。
 */
function fallbackSelectionIfGone(): void {
  if (selectedKey.value !== ALL_KEY && !groups.value.some((g) => g.key === selectedKey.value)) {
    selectedKey.value = ALL_KEY
  }
}

/** 清空当前视图：按 clearTarget 的三态决定范围，清完重新拉取并把消失的分组回落「全部」 */
async function onClear(): Promise<void> {
  try {
    await userscriptClient.clearErrors(clearTarget.value)
    await load()
    fallbackSelectionIfGone()
  } catch (e) {
    error.value = '清空失败：' + (e instanceof Error ? e.message : String(e))
  }
}

// 深链定位：宿主传入 focusUuid 时选中该脚本分组；该脚本当前没有错误则落「全部」并说明一句。
// immediate + watch 而非只 onMounted：工作台标签页常驻（unmount-on-hide=false），
// 同一页面内浮窗再次跳转会只改 prop、不重挂组件，必须靠 watch 接住；
// focusSeq 一并监听，保证「对同一脚本再点一次」也重新定位 + 拉最新。
watch(
  [() => props.focusUuid, () => props.focusSeq],
  async ([uuid]) => {
    if (!uuid) return
    await load()
    const hit = groups.value.find((g) => g.uuid === uuid)
    if (hit) {
      selectedKey.value = hit.key
      focusMissName.value = ''
      return
    }
    selectedKey.value = ALL_KEY
    focusMissName.value = await nameOf(uuid)
  },
  { immediate: true }
)

// 宿主请求重拉（脚本被删除后递增 reloadSeq）：该脚本的报错记录已随删除在后台清掉，
// 但本标签页常驻不重挂，不重拉就还显示着它的旧分组。
watch(
  () => props.reloadSeq,
  async () => {
    await load()
    fallbackSelectionIfGone()
  }
)

// 写侧落盘后已广播 `error` 域（append / 三态 clear），这里接住自动回拉，
// 不必等手动刷新；清掉当前正看的分组时按既有逻辑回落「全部」
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
      <ui-alert-triangle class="size-4 text-destructive" />
      <span class="text-sm font-medium">错误日志</span>
      <span class="text-xs text-muted-foreground">
        共 {{ errors.length }} 条 · 按脚本分类 · 环形保留最近 {{ ERROR_LOG_MAX }} 条
      </span>
      <span class="flex-1" />
      <ui-button
        variant="ghost"
        size="sm"
        class="h-7 gap-1 px-2.5 text-xs"
        title="重新拉取错误日志"
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

    <!-- 深链目标当前无错误：说明一句，而不是让用户对着「全部」猜 -->
    <p
      v-if="focusMissName"
      class="mx-4 mt-3 shrink-0 rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground"
    >
      脚本「{{ focusMissName }}」当前没有错误记录，已切到全部错误。
    </p>

    <!-- 空态：整页居中，不留空的双栏 -->
    <div
      v-if="!errors.length"
      class="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center"
    >
      <ui-alert-triangle class="size-6 text-muted-foreground" />
      <p class="text-xs text-muted-foreground">
        {{ loading ? '加载中…' : '暂无错误记录。' }}
      </p>
      <p v-if="!loading" class="max-w-md text-xs leading-relaxed text-muted-foreground">
        脚本运行期报错、注册失败与 DL 桥调用失败都会汇总到这里，按脚本分组。
      </p>
    </div>

    <div v-else class="flex min-h-0 flex-1">
      <!-- 左栏：脚本清单（各脚本错误数徽标，hover 看阶段拆解） -->
      <nav class="w-56 shrink-0 overflow-y-auto border-r border-border py-2" aria-label="按脚本分类">
        <button
          v-for="item in navItems"
          :key="item.key"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted"
          :class="
            item.key === selectedKey
              ? 'bg-muted font-medium text-foreground'
              : 'text-muted-foreground'
          "
          :title="item.hint"
          @click="selectedKey = item.key"
        >
          <span class="min-w-0 flex-1 truncate">{{ item.name }}</span>
          <ui-badge variant="secondary" class="h-4 px-1.5 text-[10px]">{{ item.count }}</ui-badge>
        </button>
      </nav>

      <!-- 右栏：当前分组的错误明细 -->
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

          <ul class="mt-2 flex flex-col gap-2">
            <li
              v-for="e in visibleErrors"
              :key="e.id"
              class="rounded-md border bg-card p-3 text-xs"
            >
              <div class="flex flex-wrap items-center gap-1.5">
                <span
                  :class="phaseBadgeClass(e.phase)"
                  class="rounded px-1.5 py-0.5 text-[10px] font-medium"
                >
                  {{ phaseLabel(e.phase) }}
                </span>
                <span v-if="showNameInCards" class="truncate font-medium">{{ e.name }}</span>
                <span class="text-muted-foreground">{{ formatTime(e.time) }}</span>
                <button
                  type="button"
                  class="ml-auto flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted"
                  :title="`复制完整错误 ID（发给 AI 可自动查询修复）：${e.id}`"
                  @click="copyErrorId(e.id)"
                >
                  <ui-check v-if="copiedErrorId === e.id" class="size-3 text-green-600" />
                  <ui-copy v-else class="size-3" />
                  {{ shortErrorId(e.id) }}
                </button>
              </div>
              <p class="mt-1 break-all text-destructive">{{ e.message }}</p>
              <p v-if="e.url" class="mt-0.5 truncate text-muted-foreground" :title="e.url">
                {{ e.url }}
              </p>
              <pre
                v-if="e.stack"
                class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-[11px] leading-relaxed"
              >{{ e.stack }}</pre>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
