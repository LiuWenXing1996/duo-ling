<script setup lang="ts">
// 「GM API」标签页：脚本世界里 `GM_*` / `GM.*` 的全部能力清单（只读速查）。
//
// 数据来源只有一处：lib/gm-api-catalog.ts —— 与注入脚本世界的真身同源，
// 契约增删方法而目录没跟上由两条防线兜住（类型层 Record<GmGlobalName> + 源码反射单测），
// 不靠人工对照。面板本身零请求、零存储：纯静态渲染，故不接 useDataSync。
import { computed, ref } from 'vue'
import { Code as UiCode, Search as UiSearch } from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import { Input as UiInput } from '@/components/ui/input'
import {
  Collapsible as UiCollapsible,
  CollapsibleContent as UiCollapsibleContent,
  CollapsibleTrigger as UiCollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  GM_API_ENTRIES,
  GM_API_GROUPS,
  GM_BRIDGE_LABELS,
  entriesOfGroup,
  type GmApiEntry,
  type GmApiGroupId,
} from '@/lib/gm-api-catalog'

/** 左栏「全部」哨兵 */
const ALL = 'all'

const keyword = ref('')
const group = ref<GmApiGroupId | typeof ALL>(ALL)
/** 每张卡片的展开状态（默认全收起：28 条全铺开根本没法扫） */
const openMap = ref<Record<string, boolean>>({})

const query = computed(() => keyword.value.trim().toLowerCase())

/** 有关键词时不看分组，全库匹配（path / 中文名 / 签名 / 说明） */
const matched = computed<GmApiEntry[] | null>(() => {
  if (!query.value) return null
  return GM_API_ENTRIES.filter((e) =>
    `${e.path} ${e.title} ${e.signature} ${e.summary} ${e.detail}`.toLowerCase().includes(query.value),
  )
})

const visible = computed<GmApiEntry[]>(() => {
  if (matched.value) return matched.value
  return group.value === ALL ? GM_API_ENTRIES : entriesOfGroup(group.value)
})

const currentGroup = computed(() => GM_API_GROUPS.find((g) => g.id === group.value) ?? null)

function countOf(id: GmApiGroupId): number {
  return entriesOfGroup(id).length
}

function isOpen(path: string): boolean {
  return openMap.value[path] ?? false
}

function setOpen(path: string, v: boolean): void {
  openMap.value[path] = v
}
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0" data-testid="gm-api-panel">
    <!-- 左栏：搜索 + 分组导航 -->
    <aside class="flex min-h-0 w-72 shrink-0 flex-col border-r border-border">
      <header class="flex items-center gap-1.5 border-b border-border px-3 py-2 text-sm font-medium">
        <ui-code class="size-4 text-muted-foreground" />
        GM API（{{ GM_API_ENTRIES.length }}）
      </header>

      <div class="relative border-b border-border p-2">
        <ui-search class="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <ui-input
          v-model="keyword"
          class="h-8 pl-8 text-xs"
          placeholder="搜方法名 / 作用"
          aria-label="搜索 GM API"
          data-testid="gm-api-search"
        />
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
        <button
          type="button"
          class="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors"
          :class="group === ALL && !query ? 'bg-muted' : 'hover:bg-muted/60'"
          data-testid="gm-api-group-all"
          @click="group = ALL; keyword = ''"
        >
          <span class="min-w-0 flex-1 truncate text-sm">全部</span>
          <span class="shrink-0 text-xs text-muted-foreground">{{ GM_API_ENTRIES.length }}</span>
        </button>

        <button
          v-for="g in GM_API_GROUPS"
          :key="g.id"
          type="button"
          class="mb-1 w-full rounded-md px-2 py-1.5 text-left transition-colors"
          :class="group === g.id && !query ? 'bg-muted' : 'hover:bg-muted/60'"
          :data-testid="`gm-api-group-${g.id}`"
          @click="group = g.id; keyword = ''"
        >
          <span class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate text-sm">{{ g.title }}</span>
            <span class="shrink-0 text-xs text-muted-foreground">{{ countOf(g.id) }}</span>
          </span>
          <span class="mt-0.5 block truncate text-[11px] text-muted-foreground">{{ g.desc }}</span>
        </button>
      </div>

      <footer class="border-t border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        清单与注入脚本世界的 <code class="font-mono">window.GM</code> / <code class="font-mono">GM_*</code> 同源
      </footer>
    </aside>

    <!-- 右栏：条目卡片 -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <header class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span class="text-sm font-medium">
          {{ query ? '搜索结果' : currentGroup ? currentGroup.title : '全部 API' }}
        </span>
        <span class="text-xs text-muted-foreground">{{ visible.length }} 条</span>
        <span class="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Badge variant="secondary" class="text-[10px]">{{ GM_BRIDGE_LABELS.bridge }}</Badge>
          后台代理
          <Badge variant="outline" class="text-[10px]">{{ GM_BRIDGE_LABELS.local }}</Badge>
          本地直连
          <Badge variant="outline" class="text-[10px]">{{ GM_BRIDGE_LABELS.stub }}</Badge>
          页面转发
        </span>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto p-3">
        <p
          v-if="!visible.length"
          class="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground"
          data-testid="gm-api-empty"
        >
          没有匹配「{{ keyword.trim() }}」的 API
        </p>

        <ui-collapsible
          v-for="e in visible"
          :key="e.path"
          :open="isOpen(e.path)"
          @update:open="setOpen(e.path, $event)"
          class="group mb-2 rounded-lg border border-border bg-card last:mb-0"
          :data-testid="`gm-api-card-${e.path}`"
        >
          <ui-collapsible-trigger
            class="flex w-full flex-col gap-0.5 p-3 text-left transition-colors hover:bg-muted/40"
            :data-testid="`gm-api-card-toggle-${e.path}`"
          >
            <span class="flex min-w-0 items-center gap-2">
              <code class="shrink-0 font-mono text-xs">{{ e.path }}</code>
              <span class="min-w-0 flex-1 truncate text-sm">{{ e.title }}</span>
              <Badge
                :variant="e.bridge === 'bridge' ? 'secondary' : 'outline'"
                class="shrink-0 text-[10px]"
              >
                {{ GM_BRIDGE_LABELS[e.bridge] }}
              </Badge>
            </span>
            <span class="truncate text-xs text-muted-foreground">{{ e.summary }}</span>
          </ui-collapsible-trigger>

          <ui-collapsible-content class="overflow-hidden">
            <div class="border-t border-border/60 p-3">
              <pre class="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-relaxed">{{ e.signature }}</pre>
            </div>
            <div class="border-t border-border/60 p-3">
              <h4 class="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">说明</h4>
              <p class="text-xs leading-relaxed text-muted-foreground">{{ e.detail }}</p>
            </div>
            <div class="border-t border-border/60 p-3">
              <h4 class="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">返回</h4>
              <p class="break-words font-mono text-[11px] leading-relaxed">{{ e.returns }}</p>
            </div>
          </ui-collapsible-content>
        </ui-collapsible>
      </div>
    </div>
  </section>
</template>
