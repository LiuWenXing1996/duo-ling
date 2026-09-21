<script setup lang="ts">
// 「AI 工具」标签页：agent 工具契约 + 调用轨迹（只读）。
//
// 两块内容：
//   ① 契约：每次对话真实挂给模型的 6 个工具（描述文本与运行时同源，见 lib/agent-tools-catalog.ts）
//      —— 这是「模型能做什么」的权威清单，改工具契约时对着它核对。
//   ② 轨迹：从会话库（duoling-chat）落盘消息的 `tool-<name>` parts 里抽出**真实发生过的调用**
//      （入参 / 结果 / 状态 / 时间 / 来自哪个会话），用于回答「这一步它到底调了什么、成没成」。
//
// 数据来源都是扩展页同源可读的库：契约 = 静态目录，轨迹 = conversation-store 直连 IndexedDB
// （写仍唯一归 offscreen）。变更经 useDataSync('conversation') 自动回拉。
import { computed, onMounted, ref } from 'vue'
import type { ToolUIPart } from 'ai'
import { ChevronDown as UiChevronDown, RefreshCw as UiRefreshCw, Wrench as UiWrench } from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import {
  Collapsible as UiCollapsible,
  CollapsibleContent as UiCollapsibleContent,
  CollapsibleTrigger as UiCollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Tool as UiTool,
  ToolContent as UiToolContent,
  ToolHeader as UiToolHeader,
} from '@/components/ai-elements/tool'
import * as conversationStore from '@/lib/conversation-store'
import { getToolName, isToolUIPart } from '@/lib/ui-message-parts'
import { useDataSync } from '@/composables/use-data-sync'
import {
  AGENT_RUNTIME_LIMITS,
  AGENT_TOOL_TITLES,
  AGENT_TOOL_VIEWS,
  type AgentToolView,
} from '@/lib/agent-tools-catalog'

/** 左栏「全部工具」哨兵值 */
const ALL = '__all__'
/** 轨迹扫描范围：最近这么多个会话（会话多时全扫代价高，且老记录参考价值低） */
const SCAN_CONVERSATIONS = 10
/** 单次最多渲染多少条轨迹（超出只提示，不展开 DOM） */
const TRACE_LIMIT = 200
/** 单个入参 / 结果块的展示上限（script_apply 的 files 是整个文件树，不截断会把面板撑爆） */
const BLOCK_LIMIT = 4000

/** 一条落盘的工具调用记录 */
interface ToolTrace {
  key: string
  toolName: string
  state: ToolUIPart['state']
  input: unknown
  output: unknown
  errorText?: string
  /** 所在消息的落盘时间（ISO） */
  at: string
  conversationTitle: string
}

const selected = ref<string>(ALL)
/** 契约详情是否展开：**默认收起** —— 入参表可能很长（script_apply 有 10 项），
 *  不收起来会把下方的调用轨迹整块顶出屏幕（轨迹才是排查时最常看的那半屏）。
 *  切换工具时保持用户当前选择，不重置。 */
const contractOpen = ref(false)
const loading = ref(false)
const error = ref('')
/** 全量轨迹（按时间倒序；渲染时再截断） */
const traces = ref<ToolTrace[]>([])
/** 实际扫描到的会话数（0 = 会话库为空） */
const scanned = ref(0)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const conversations = (await conversationStore.listConversations())
      .slice()
      .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1))
      .slice(0, SCAN_CONVERSATIONS)
    const out: ToolTrace[] = []
    for (const c of conversations) {
      const messages = await conversationStore.listMessages(c.id)
      for (const m of messages) {
        // 工具调用只可能出现在 assistant 分支
        if (m.role !== 'assistant') continue
        for (const [i, part] of (m.parts ?? []).entries()) {
          if (!isToolUIPart(part)) continue
          // 联合类型的按 state 收窄读写都很啰嗦，这里统一按「字段袋」取（缺字段即 undefined）
          const rec = part as unknown as Record<string, unknown>
          out.push({
            key: `${m.id}:${i}`,
            toolName: getToolName(part),
            state: part.state,
            input: rec.input,
            output: rec.output,
            ...(typeof rec.errorText === 'string' ? { errorText: rec.errorText } : {}),
            at: m.createdAt,
            conversationTitle: c.title,
          })
        }
      }
    }
    out.sort((a, b) => (a.at < b.at ? 1 : -1))
    traces.value = out
    scanned.value = conversations.length
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())
// 别处落盘了新对话 / 新工具调用（offscreen 是唯一写方）：回拉一次
useDataSync('conversation', () => void load())

// —— 派生 ——

/** 工具名 → 调用次数 / 失败次数（左栏计数与总览用；统计口径 = 已扫描范围内） */
const stats = computed(() => {
  const map = new Map<string, { total: number; failed: number }>()
  for (const t of traces.value) {
    const cur = map.get(t.toolName) ?? { total: 0, failed: 0 }
    cur.total += 1
    if (t.state === 'output-error') cur.failed += 1
    map.set(t.toolName, cur)
  }
  return map
})

const selectedView = computed<AgentToolView | null>(
  () => AGENT_TOOL_VIEWS.find((t) => t.name === selected.value) ?? null,
)

const tracesOfSelected = computed(() =>
  selected.value === ALL ? traces.value : traces.value.filter((t) => t.toolName === selected.value),
)
const visibleTraces = computed(() => tracesOfSelected.value.slice(0, TRACE_LIMIT))

function countOf(name: string): number {
  return stats.value.get(name)?.total ?? 0
}

// —— 展示辅助 ——

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 工具名 → 中文短名（未收录的工具照原名显示，不隐藏——新工具上线时这里要补） */
function titleOf(name: string): string {
  return AGENT_TOOL_TITLES[name] ?? name
}

/** 拼 `tool-<name>`：ai 的 ToolUIPart['type'] 是模板字面量类型，动态拼出来的 string 需在此收窄一次 */
function partType(name: string): `tool-${string}` {
  return `tool-${name}`
}

/** 入参 / 结果块：JSON 化 + 截断（大 payload 只提示总长度，不整块塞进 DOM） */
function block(value: unknown): string {
  if (value === undefined) return '（无）'
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  return text.length > BLOCK_LIMIT
    ? `${text.slice(0, BLOCK_LIMIT)}\n…（已截断，共 ${text.length} 字符）`
    : text
}
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0" data-testid="agent-tools-panel">
    <!-- 左栏：工具清单（含「全部工具」）+ 运行时闸门 -->
    <aside class="flex min-h-0 w-72 shrink-0 flex-col border-r border-border">
      <header class="flex items-center justify-between border-b border-border px-3 py-2">
        <div class="flex items-center gap-1.5 text-sm font-medium">
          <ui-wrench class="size-4 text-muted-foreground" />
          AI 工具（{{ AGENT_TOOL_VIEWS.length }}）
        </div>
        <button
          type="button"
          class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          :disabled="loading"
          aria-label="重新读取"
          data-testid="agent-tools-refresh"
          @click="load()"
        >
          <ui-refresh-cw class="size-4" :class="{ 'animate-spin': loading }" />
        </button>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
        <button
          type="button"
          class="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors"
          :class="selected === ALL ? 'bg-muted' : 'hover:bg-muted/60'"
          data-testid="agent-tools-select-all"
          @click="selected = ALL"
        >
          <span class="min-w-0 flex-1 truncate text-sm">全部工具</span>
          <span class="shrink-0 text-xs text-muted-foreground">{{ traces.length }} 次调用</span>
        </button>

        <button
          v-for="tool in AGENT_TOOL_VIEWS"
          :key="tool.name"
          type="button"
          class="mb-1 w-full rounded-md px-2 py-1.5 text-left transition-colors"
          :class="selected === tool.name ? 'bg-muted' : 'hover:bg-muted/60'"
          :data-testid="`agent-tools-select-${tool.name}`"
          @click="selected = tool.name"
        >
          <span class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate text-sm">{{ tool.title }}</span>
            <span
              class="shrink-0 text-xs"
              :class="countOf(tool.name) ? 'text-muted-foreground' : 'text-muted-foreground/60'"
            >
              {{ countOf(tool.name) }}
            </span>
          </span>
          <span class="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
            {{ tool.name }}
          </span>
        </button>
      </div>

      <!-- 两道闸：与运行时同源（AGENT_RUNTIME_LIMITS） -->
      <footer class="flex flex-col gap-1 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        <span>单任务最多 {{ AGENT_RUNTIME_LIMITS.maxSteps }} 步</span>
        <span>script_apply 连败 {{ AGENT_RUNTIME_LIMITS.maxApplyFailures }} 次即停手</span>
      </footer>
    </aside>

    <!-- 右栏：选中工具的契约 + 调用轨迹 -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <header class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span class="text-sm font-medium">{{ selectedView ? selectedView.title : '全部工具' }}</span>
        <code v-if="selectedView" class="font-mono text-xs text-muted-foreground">{{ selectedView.name }}</code>
        <span class="ml-auto text-xs text-muted-foreground">
          轨迹来自最近 {{ scanned }} 个会话的记录
        </span>
      </header>

      <p v-if="error" class="m-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive" role="alert">
        {{ error }}
      </p>

      <div class="min-h-0 flex-1 overflow-y-auto p-3">
        <!-- 契约区 -->
        <article class="rounded-lg border border-border bg-card" data-testid="agent-tools-contract">
          <template v-if="selectedView">
            <ui-collapsible v-model:open="contractOpen" class="group">
              <ui-collapsible-trigger
                class="flex w-full items-center justify-between gap-3 p-3 text-left transition-colors hover:bg-muted/40"
                data-testid="agent-tools-contract-toggle"
              >
                <span class="flex min-w-0 flex-col gap-0.5">
                  <span class="truncate text-sm font-medium">{{ selectedView.summary }}</span>
                  <span class="text-[11px] text-muted-foreground">
                    契约详情 ·
                    {{ selectedView.params.length ? `${selectedView.params.length} 个入参` : '无入参' }}
                    · 描述原文 / 返回 / 何时不可用
                  </span>
                </span>
                <ui-chevron-down
                  class="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
                />
              </ui-collapsible-trigger>

              <ui-collapsible-content
                class="overflow-hidden data-[state=closed]:animate-out data-[state=open]:animate-in"
              >
                <div class="border-t border-border/60 p-3">
                  <p class="text-xs leading-relaxed text-muted-foreground">{{ selectedView.description }}</p>
                </div>

                <div class="border-t border-border/60 p-3">
                  <h4 class="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    入参
                  </h4>
                  <p v-if="!selectedView.params.length" class="text-xs text-muted-foreground">无入参</p>
                  <div
                    v-for="p in selectedView.params"
                    :key="p.name"
                    class="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border/40 py-1.5 last:border-b-0"
                  >
                    <code class="font-mono text-xs">{{ p.name }}</code>
                    <code class="font-mono text-[11px] text-muted-foreground">{{ p.type }}</code>
                    <Badge v-if="p.required" variant="secondary" class="text-[10px]">必填</Badge>
                    <span v-else class="text-[11px] text-muted-foreground">
                      选填<template v-if="p.default"> · 默认 {{ p.default }}</template>
                    </span>
                    <span class="w-full text-xs leading-relaxed text-muted-foreground">{{ p.desc }}</span>
                  </div>
                </div>

                <div class="flex flex-col gap-1 border-t border-border/60 p-3 text-xs">
                  <h4 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">返回</h4>
                  <p class="break-words font-mono text-[11px] leading-relaxed">{{ selectedView.returns }}</p>
                </div>

                <div class="flex flex-col gap-1 border-t border-border/60 p-3 text-xs">
                  <h4 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    何时不可用
                  </h4>
                  <p class="text-muted-foreground">{{ selectedView.unavailable }}</p>
                </div>
              </ui-collapsible-content>
            </ui-collapsible>
          </template>

          <!-- 全部工具：一张速查表（名字 / 一句作用 / 调用次数） -->
          <template v-else>
            <div class="border-b border-border/60 p-3">
              <p class="text-xs leading-relaxed text-muted-foreground">
                这是每次对话真实挂给模型的工具集。描述文本与模型收到的同源；
                点左侧任一工具看完整契约，往下是对应的真实调用记录。
              </p>
            </div>
            <div
              v-for="tool in AGENT_TOOL_VIEWS"
              :key="tool.name"
              class="flex cursor-pointer items-baseline gap-2 border-b border-border/40 px-3 py-2 last:border-b-0 hover:bg-muted/40"
              @click="selected = tool.name"
            >
              <code class="shrink-0 font-mono text-xs">{{ tool.name }}</code>
              <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ tool.summary }}</span>
              <span class="shrink-0 text-xs text-muted-foreground">{{ countOf(tool.name) }} 次</span>
            </div>
          </template>
        </article>

        <!-- 轨迹区 -->
        <h3 class="mb-2 mt-4 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          调用轨迹
          <span v-if="tracesOfSelected.length" class="normal-case">
            {{ tracesOfSelected.length }} 次<template v-if="tracesOfSelected.length > visibleTraces.length">（仅显示最近 {{ TRACE_LIMIT }} 次）</template>
          </span>
        </h3>
        <p v-if="loading" class="text-xs text-muted-foreground">读取中…</p>
        <p
          v-else-if="!tracesOfSelected.length"
          class="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground"
        >
          {{ scanned ? '还没有这条工具的调用记录' : '暂无会话记录——对话产生工具调用后这里才有记录' }}
        </p>

        <ui-tool
          v-for="t in visibleTraces"
          :key="t.key"
          class="bg-card"
          :data-testid="`agent-tools-trace-${t.toolName}`"
        >
          <ui-tool-header
            :type="partType(t.toolName)"
            :state="t.state"
            :title="titleOf(t.toolName)"
          />
          <ui-tool-content>
            <div class="flex flex-col gap-2 p-3 text-xs">
              <div class="flex flex-wrap items-center gap-2 text-muted-foreground">
                <span>{{ fmtTime(t.at) }}</span>
                <span class="truncate">{{ t.conversationTitle }}</span>
              </div>
              <div>
                <h4 class="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  入参
                </h4>
                <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-relaxed">{{ block(t.input) }}</pre>
              </div>
              <div v-if="t.errorText">
                <h4 class="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  错误
                </h4>
                <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-destructive/10 p-2 font-mono text-[11px] leading-relaxed text-destructive">{{ block(t.errorText) }}</pre>
              </div>
              <div v-else-if="t.output !== undefined">
                <h4 class="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  结果
                </h4>
                <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-relaxed">{{ block(t.output) }}</pre>
              </div>
            </div>
          </ui-tool-content>
        </ui-tool>
      </div>
    </div>
  </section>
</template>
