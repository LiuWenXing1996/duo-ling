<script setup lang="ts">
// 「会话数据」标签页：会话库（IndexedDB duoling-chat）的落盘原始视图，只读调试用。
//
// 动机：侧边栏只有逻辑视图（气泡 / chip），落盘真相（Message 对象里有没有 pageContext /
// parts / usage）无处可看——切会话 chip 丢失这类 bug 需要直接对照库里的记录。本面板 =
// lfs 浏览的会话库版：左栏会话列表，右栏该会话全部消息的落盘字段（含拾取上下文、token、
// parts 类型），每条可展开看原始 JSON。
//
// 读走 conversation-store 直连 IndexedDB（与 window-api 同款姿势，工作台是扩展页同源可读）；
// 本面板**只读**，写入仍唯一归 offscreen。
import { onMounted, ref, watch } from 'vue'
import { useDataSync } from '@/composables/use-data-sync'
import { Database as UiDatabase, RefreshCw as UiRefreshCw } from '@lucide/vue'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger
} from '@/components/ui/tooltip'
import * as conversationStore from '@/lib/conversation-store'
import type { Conversation, Message } from '@/shared/types'

const loading = ref(false)
const error = ref('')
const conversations = ref<Conversation[]>([])
const selectedId = ref('')
const messages = ref<Message[]>([])
const messagesLoading = ref(false)

/** 消息展开原始 JSON 的 id 集合（默认全收起） */
const expanded = ref(new Set<string>())

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    conversations.value = await conversationStore.listConversations()
    // 当前选中的会话被删掉时清掉选中态
    if (selectedId.value && !conversations.value.some((c) => c.id === selectedId.value)) {
      selectedId.value = ''
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadMessages(id: string): Promise<void> {
  messages.value = []
  if (!id) return
  messagesLoading.value = true
  try {
    messages.value = await conversationStore.listMessages(id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    messagesLoading.value = false
  }
}

watch(selectedId, (id) => {
  expanded.value = new Set()
  void loadMessages(id)
})

onMounted(() => void refresh())

// 别处增删改会话 / 消息落盘：回拉列表，并刷新当前选中会话的消息（调试视图要照见最新落盘）
useDataSync('conversation', () => {
  void refresh()
  if (selectedId.value) void loadMessages(selectedId.value)
})

function toggleRaw(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function toggleAllRaw(): void {
  expanded.value = expanded.value.size ? new Set() : new Set(messages.value.map((m) => m.id))
}

// —— 展示辅助 ——

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 落盘字段概览：parts 里出现过哪些块类型（排查卡片 / 工具调用是否落库） */
function partTypes(m: Message): string[] {
  return [...new Set((m.parts ?? []).map((p) => p.type))]
}

/** 随消息落盘的拾取概览（排查 pageContext 是否真的进了库）；旧数据里的 snapshot 字段不再展示 */
function pageContextLabel(m: Message): string {
  const ctx = m.pageContext
  if (!ctx?.element) return ''
  const s = ctx.element.summary
  return `已点选 <${s.tag}${s.id ? '#' + s.id : ''}>`
}
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0" data-testid="chat-data-panel">
    <!-- 左栏：会话列表 -->
    <aside class="flex min-h-0 w-72 shrink-0 flex-col border-r border-border">
      <header class="flex items-center justify-between border-b border-border px-3 py-2">
        <div class="flex items-center gap-1.5 text-sm font-medium">
          <ui-database class="size-4 text-muted-foreground" />
          会话库（{{ conversations.length }}）
        </div>
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <button
                type="button"
                class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                :disabled="loading"
                aria-label="重新读取"
                data-testid="chat-data-refresh"
                @click="refresh()"
              >
                <ui-refresh-cw class="size-4" :class="{ 'animate-spin': loading }" />
              </button>
            </ui-tooltip-trigger>
            <ui-tooltip-content>重新读取</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
      </header>
      <p v-if="error" class="m-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive" role="alert">
        {{ error }}
      </p>
      <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
        <p v-if="!loading && conversations.length === 0" class="px-2 py-4 text-center text-xs text-muted-foreground">
          会话库为空
        </p>
        <button
          v-for="c in conversations"
          :key="c.id"
          type="button"
          class="mb-1 w-full rounded-md px-2 py-1.5 text-left transition-colors"
          :class="c.id === selectedId ? 'bg-muted' : 'hover:bg-muted/60'"
          :data-testid="`chat-data-conv-${c.id}`"
          @click="selectedId = c.id"
        >
          <span class="block truncate text-sm" :title="c.title">{{ c.title }}</span>
          <span class="mt-0.5 block text-xs text-muted-foreground">
            {{ formatTime(c.lastMessageAt) }}
            <template v-if="c.totalTokens"> · {{ c.totalTokens }} tokens</template>
          </span>
        </button>
      </div>
    </aside>

    <!-- 右栏：选中会话的全部落盘消息 -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <header class="flex items-center justify-between border-b border-border px-3 py-2 text-sm">
        <span class="truncate text-muted-foreground">
          {{ selectedId ? `共 ${messages.length} 条消息` : '左侧选择一个会话' }}
        </span>
        <button
          v-if="selectedId && messages.length"
          type="button"
          class="shrink-0 rounded-md px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          data-testid="chat-data-toggle-all"
          @click="toggleAllRaw()"
        >
          {{ expanded.size ? '全部收起 JSON' : '展开全部 JSON' }}
        </button>
      </header>
      <div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        <p v-if="messagesLoading" class="text-xs text-muted-foreground">读取中…</p>
        <template v-else>
          <article
            v-for="m in messages"
            :key="m.id"
            class="rounded-lg border border-border bg-card text-sm"
            :data-testid="`chat-data-msg-${m.id}`"
          >
            <!-- 头部：角色 / 时间 / token / 落盘块类型 -->
            <div class="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground">
              <span
                class="rounded-full px-2 py-0.5"
                :class="m.role === 'user' ? 'bg-primary/10 text-foreground' : 'bg-muted text-muted-foreground'"
              >
                {{ m.role === 'user' ? '用户' : 'AI' }}
              </span>
              <span>{{ formatTime(m.createdAt) }}</span>
              <span v-if="m.usage?.totalTokens">· {{ m.usage.totalTokens }} tokens</span>
              <span v-if="partTypes(m).length" class="min-w-0 truncate" :title="partTypes(m).join('，')">
                · {{ partTypes(m).join('，') }}
              </span>
              <!-- 拾取落盘标记（本面板的核心排查点，有则高亮） -->
              <span
                v-if="pageContextLabel(m)"
                class="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-600"
                data-testid="chat-data-page-context"
              >
                {{ pageContextLabel(m) }}
              </span>
            </div>
            <!-- 正文（reasoning 不重复展示，原始 JSON 里有） -->
            <p class="max-h-64 overflow-y-auto whitespace-pre-wrap break-words px-2.5 py-2 leading-relaxed">
              {{ m.content || '（无正文）' }}
            </p>
            <div class="px-2.5 pb-2">
              <button
                type="button"
                class="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                :data-testid="`chat-data-raw-${m.id}`"
                @click="toggleRaw(m.id)"
              >
                {{ expanded.has(m.id) ? '收起原始 JSON' : '原始 JSON' }}
              </button>
              <pre
                v-if="expanded.has(m.id)"
                class="mt-1.5 max-h-96 overflow-auto rounded-md bg-muted p-2 text-xs leading-relaxed"
              >{{ JSON.stringify(m, null, 2) }}</pre>
            </div>
          </article>
          <p v-if="!messages.length && selectedId" class="text-xs text-muted-foreground">该会话暂无消息</p>
        </template>
      </div>
    </div>
  </section>
</template>
