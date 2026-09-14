<script setup lang="ts">
// 会话历史侧栏（常驻两栏布局的「展开态」）：工具内各会话的列表 + 新建 / 会话操作（重命名 / 删除）。
// 头部含标题与「会话数」徽标、删除全部、新建、收起（收起由父级两栏布局承载，此处只发 close）；
// 标题下方搜索框（按标题/内容实时过滤，命中走 window.api.conversation.search）；
// 非搜索态按「今天 / 昨天 / 日期」分组并展示最近一条消息预览，搜索态展示命中片段；
// 每项的「更多」下拉菜单含重命名与删除，删除确认 / 重命名用 UI 弹窗，均由本组件自含单一实例。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  ChevronLeft as UiChevronLeft,
  ListTodo as UiListTodo,
  MoreHorizontal as UiMoreHorizontal,
  Pencil as UiPencil,
  Plus as UiPlus,
  Search as UiSearch,
  Trash2 as UiTrash2
} from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  Dialog as UiDialog,
  DialogContent as UiDialogContent,
  DialogDescription as UiDialogDescription,
  DialogFooter as UiDialogFooter,
  DialogTitle as UiDialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu as UiDropdownMenu,
  DropdownMenuContent as UiDropdownMenuContent,
  DropdownMenuItem as UiDropdownMenuItem,
  DropdownMenuSeparator as UiDropdownMenuSeparator,
  DropdownMenuTrigger as UiDropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input as UiInput } from '@/components/ui/input'
import type { Conversation, ConversationSearchHit } from '@/shared/types'
import { formatSessionTime } from '@/composables/use-global-conversation'

const props = defineProps<{
  conversations: Conversation[]
  activeConversationId: string
}>()
const emit = defineEmits<{
  activate: [id: string]
  new: []
  delete: [payload: { type: 'session' | 'all'; id?: string; title?: string }]
  rename: [payload: { id: string; title: string }]
  close: []
}>()

// —— 搜索：防抖调主进程 conversation:search；空查询回落到 props.conversations（按日期分组）——
const query = ref('')
const searchHits = ref<ConversationSearchHit[]>([])
const isSearching = computed(() => query.value.trim().length > 0)
let searchTimer: ReturnType<typeof setTimeout> | null = null

watch(query, (val) => {
  const q = val.trim()
  if (searchTimer) clearTimeout(searchTimer)
  if (!q) {
    searchHits.value = []
    return
  }
  searchTimer = setTimeout(async () => {
    try {
      searchHits.value = await window.api.conversation.search(q)
    } catch {
      searchHits.value = []
    }
  }, 180)
})
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

// —— 列表展示项：把 Conversation 与命中片段统一成展示模型 ——
interface DisplayItem {
  id: string
  title: string
  time: string
  tokens?: number
  preview: string
  isActive: boolean
}

/** token 量格式化：>=1k 用「1.2k」简写，否则原值 */
function formatTokens(n?: number): string {
  if (!n) return ''
  if (n >= 1000) return n >= 10000 ? `${(n / 1000).toFixed(0)}k` : `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function toDisplayItem(c: Conversation, preview: string): DisplayItem {
  return {
    id: c.id,
    title: c.title,
    time: formatSessionTime(c.lastMessageAt),
    tokens: c.totalTokens,
    preview,
    isActive: c.id === props.activeConversationId
  }
}

/** 按最后消息时间归类：今天(0) / 昨天(1) / 更早按距今天数(2,3,…)，标签同日用「M月D日」、跨年带年份 */
function dateGroup(iso: string): { dayIndex: number; label: string } {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { dayIndex: 9999, label: '更早' }
  const now = new Date()
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.floor((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (diffDays <= 0) return { dayIndex: 0, label: '今天' }
  if (diffDays === 1) return { dayIndex: 1, label: '昨天' }
  const sameYear = d.getFullYear() === now.getFullYear()
  const label = sameYear
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  return { dayIndex: diffDays, label }
}

const groups = computed<{ label: string; items: DisplayItem[] }[]>(() => {
  if (isSearching.value) return []
  const byIndex = new Map<number, { label: string; items: DisplayItem[] }>()
  for (const c of props.conversations) {
    const g = dateGroup(c.lastMessageAt)
    let bucket = byIndex.get(g.dayIndex)
    if (!bucket) {
      bucket = { label: g.label, items: [] }
      byIndex.set(g.dayIndex, bucket)
    }
    bucket.items.push(toDisplayItem(c, c.lastMessagePreview ?? ''))
  }
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
})

const searchItems = computed<DisplayItem[]>(() =>
  searchHits.value.map((h) => toDisplayItem(h.conversation, h.snippet || h.conversation.lastMessagePreview || ''))
)

const totalCount = computed(() => props.conversations.length)

// —— 删除确认弹窗：记录当前删除目标（单个会话 / 全部），弹窗开合由 deleteOpen 控制 ——
const deleteTarget = ref<{ type: 'session' | 'all'; id?: string; title?: string } | null>(null)
const deleteOpen = ref(false)

function openDelete(target: { type: 'session' | 'all'; id?: string; title?: string }): void {
  deleteTarget.value = target
  deleteOpen.value = true
}

function cancelDelete(): void {
  deleteOpen.value = false
}

function confirmDelete(): void {
  const t = deleteTarget.value
  if (!t) return
  emit('delete', { type: t.type, id: t.id, title: t.title })
  deleteOpen.value = false
}

// —— 重命名弹窗：输入框预填当前标题，确认后 emit rename ——
const renameTargetId = ref<string | null>(null)
const renameOpen = ref(false)
const renameTitle = ref('')

function openRename(id: string, title: string): void {
  renameTargetId.value = id
  renameTitle.value = title
  renameOpen.value = true
}

function cancelRename(): void {
  renameOpen.value = false
}

function confirmRename(): void {
  const id = renameTargetId.value
  const title = renameTitle.value.trim()
  if (!id || !title) return
  emit('rename', { id, title })
  renameOpen.value = false
}
</script>

<template>
  <aside class="tool-sess panel flex min-h-0 flex-1 flex-col overflow-hidden">
    <header class="panel-header flex items-center justify-between gap-2 pr-2">
      <h2 class="panel-title flex items-center gap-2">
        <ui-list-todo class="size-4" />
        会话历史
        <span
          v-if="!isSearching"
          class="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-normal leading-none text-muted-foreground"
          >{{ totalCount }}</span
        >
      </h2>
      <div class="flex items-center gap-1">
        <ui-button
          variant="ghost"
          size="icon"
          class="no-drag size-7"
          aria-label="删除全部会话"
          title="删除全部会话"
          :disabled="!props.conversations.length"
          @click.stop="openDelete({ type: 'all' })"
        >
          <ui-trash2 class="size-4" />
        </ui-button>
        <ui-button
          variant="ghost"
          size="icon"
          class="no-drag size-7"
          aria-label="新建会话"
          title="新建会话"
          @click="emit('new')"
        >
          <ui-plus class="size-4" />
        </ui-button>
        <ui-button
          variant="ghost"
          size="icon"
          class="no-drag size-7"
          aria-label="收起"
          title="收起"
          @click="emit('close')"
        >
          <ui-chevron-left class="size-4" />
        </ui-button>
      </div>
    </header>

    <!-- 搜索框：按标题 / 内容实时过滤；空查询回落到分组列表 -->
    <div class="shrink-0 border-b border-border px-3 py-2">
      <div class="relative">
        <ui-search
          class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <ui-input
          v-model="query"
          type="text"
          placeholder="搜索会话标题或内容…"
          class="h-8 pl-8 text-xs"
        />
      </div>
    </div>

    <!-- 列表容器：scroll-gap 仅给右侧留 3px 空隙（滚动条贴边保护） -->
    <div class="min-h-0 flex-1 overflow-y-auto scroll-gap">
      <!-- 搜索态：扁平列表，展示命中片段 -->
      <template v-if="isSearching">
        <ul v-if="searchItems.length" class="py-1">
          <li
            v-for="s in searchItems"
            :key="s.id"
            class="group relative flex cursor-pointer items-start gap-2 border-l-2 px-4 py-2.5 transition-colors"
            :class="
              s.isActive
                ? 'border-l-primary bg-accent'
                : 'border-l-transparent hover:bg-accent'
            "
            @click="emit('activate', s.id)"
          >
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{{ s.title }}</p>
              <p v-if="s.preview" class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {{ s.preview }}
              </p>
              <p class="mt-0.5 text-xs text-muted-foreground">
                {{ s.time
                }}<template v-if="s.tokens"
                  ><span class="mx-1">·</span>{{ formatTokens(s.tokens) }} tokens</template
                >
              </p>
            </div>
            <ui-dropdown-menu>
              <ui-dropdown-menu-trigger as-child>
                <ui-button
                  variant="ghost"
                  size="icon"
                  class="size-6 shrink-0 text-muted-foreground transition-opacity no-drag"
                  :class="s.isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
                  aria-label="会话操作"
                  title="会话操作"
                  @click.stop
                >
                  <ui-more-horizontal class="size-3.5" />
                </ui-button>
              </ui-dropdown-menu-trigger>
              <ui-dropdown-menu-content align="end" class="min-w-[120px]">
                <ui-dropdown-menu-item @click.stop="openRename(s.id, s.title)">
                  <ui-pencil class="size-3.5" />
                  重命名
                </ui-dropdown-menu-item>
                <ui-dropdown-menu-separator />
                <ui-dropdown-menu-item
                  class="text-destructive focus:text-destructive"
                  @click.stop="openDelete({ type: 'session', id: s.id, title: s.title })"
                >
                  <ui-trash2 class="size-3.5" />
                  删除
                </ui-dropdown-menu-item>
              </ui-dropdown-menu-content>
            </ui-dropdown-menu>
          </li>
        </ul>
        <div v-else class="panel-body">
          <p class="panel-empty">未找到匹配的会话</p>
        </div>
      </template>

      <!-- 非搜索态：按日期分组，组头 sticky -->
      <template v-else>
        <template v-for="g in groups" :key="g.label">
          <div
            class="sticky top-0 z-[1] bg-background px-4 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground"
          >
            {{ g.label }}
          </div>
          <ul class="pb-1">
            <li
              v-for="s in g.items"
              :key="s.id"
              class="group relative flex cursor-pointer items-start gap-2 border-l-2 px-4 py-2.5 transition-colors"
              :class="
                s.isActive
                  ? 'border-l-primary bg-accent'
                  : 'border-l-transparent hover:bg-accent'
              "
              @click="emit('activate', s.id)"
            >
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium">{{ s.title }}</p>
                <p v-if="s.preview" class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                  {{ s.preview }}
                </p>
                <p class="mt-0.5 text-xs text-muted-foreground">
                  {{ s.time
                  }}<template v-if="s.tokens"
                    ><span class="mx-1">·</span>{{ formatTokens(s.tokens) }} tokens</template
                  >
                </p>
              </div>
              <ui-dropdown-menu>
                <ui-dropdown-menu-trigger as-child>
                  <ui-button
                    variant="ghost"
                    size="icon"
                    class="size-6 shrink-0 text-muted-foreground transition-opacity no-drag"
                    :class="s.isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
                    aria-label="会话操作"
                    title="会话操作"
                    @click.stop
                  >
                    <ui-more-horizontal class="size-3.5" />
                  </ui-button>
                </ui-dropdown-menu-trigger>
                <ui-dropdown-menu-content align="end" class="min-w-[120px]">
                  <ui-dropdown-menu-item @click.stop="openRename(s.id, s.title)">
                    <ui-pencil class="size-3.5" />
                    重命名
                  </ui-dropdown-menu-item>
                  <ui-dropdown-menu-separator />
                  <ui-dropdown-menu-item
                    class="text-destructive focus:text-destructive"
                    @click.stop="openDelete({ type: 'session', id: s.id, title: s.title })"
                  >
                    <ui-trash2 class="size-3.5" />
                    删除
                  </ui-dropdown-menu-item>
                </ui-dropdown-menu-content>
              </ui-dropdown-menu>
            </li>
          </ul>
        </template>
        <div v-if="!totalCount" class="panel-body">
          <p class="panel-empty">暂无会话</p>
        </div>
      </template>
    </div>

    <!-- 重命名会话弹窗：输入框预填当前标题 -->
    <ui-dialog :open="renameOpen" @update:open="renameOpen = $event">
      <ui-dialog-content class="max-w-sm">
        <ui-dialog-title class="text-base font-semibold">重命名会话</ui-dialog-title>
        <ui-dialog-description class="text-sm text-muted-foreground">
          输入新的会话名称
        </ui-dialog-description>
        <ui-input
          v-model="renameTitle"
          class="mt-3"
          placeholder="会话名称"
          @keyup.enter="confirmRename"
        />
        <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
          <ui-button variant="ghost" size="sm" @click="cancelRename">取消</ui-button>
          <ui-button size="sm" @click="confirmRename">确定</ui-button>
        </ui-dialog-footer>
      </ui-dialog-content>
    </ui-dialog>

    <!-- 删除确认弹窗：单个会话 / 全部，用 UI Dialog 承载 -->
    <ui-dialog :open="deleteOpen" @update:open="deleteOpen = $event">
      <ui-dialog-content class="max-w-md">
        <ui-dialog-title class="text-base font-semibold">删除会话</ui-dialog-title>
        <ui-dialog-description class="text-sm text-muted-foreground">
          {{
            deleteTarget?.type === 'all'
              ? '确定删除所有会话吗？删除后全部聊天记录将不可恢复。'
              : `确定删除会话「${deleteTarget?.title}」吗？删除后聊天记录将不可恢复。`
          }}
        </ui-dialog-description>
        <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
          <ui-button variant="ghost" size="sm" @click="cancelDelete">取消</ui-button>
          <ui-button variant="destructive" size="sm" @click="confirmDelete">删除</ui-button>
        </ui-dialog-footer>
      </ui-dialog-content>
    </ui-dialog>
  </aside>
</template>
