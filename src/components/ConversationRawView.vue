<script setup lang="ts">
// 会话落盘原始视图（只读调试）：某条会话全部消息的 IndexedDB 原始记录。
//
// 动机：对话界面与会话历史回放都是逻辑视图（气泡 / chip），落盘真相（Message 对象里有没有
// pageContext / parts / usage）无处可看——切会话 chip 丢失这类 bug 需要直接对照库里的记录。
// 本视图与逻辑回放（ChatPanel readonly）同挂一栏，切换即对照，不需要再隔着标签页翻。
//
// 读走 conversation-store 直连 IndexedDB（与 window-api 同款姿势，工作台是扩展页同源可读）；
// 本视图**只读**，写入仍唯一归 offscreen。选中会话由父层给定（不自带列表），列表管理与
// 删除前置门都归父层。
import { ref, watch } from 'vue'
import { useDataSync } from '@/composables/use-data-sync'
import { RefreshCw as UiRefreshCw } from '@lucide/vue'
import * as conversationStore from '@/lib/conversation-store'
import type { Conversation, Message } from '@/shared/types'
import { errorText, formatTimeWithSeconds } from '@/lib/format'

const props = defineProps<{
  /** 展示哪条会话的落盘记录；为 null 时显示空态（父层未选中 / 会话已被删） */
  conversation: Conversation | null
}>()

const error = ref('')
const messages = ref<Message[]>([])
const messagesLoading = ref(false)

/** 消息展开原始 JSON 的 id 集合（默认全收起） */
const expanded = ref(new Set<string>())

async function loadMessages(id: string): Promise<void> {
  messages.value = []
  if (!id) return
  messagesLoading.value = true
  try {
    messages.value = await conversationStore.listMessages(id)
  } catch (e) {
    error.value = errorText(e)
  } finally {
    messagesLoading.value = false
  }
}

// 选中会话变化（含清空）：重置展开态并重拉
watch(
  () => props.conversation?.id ?? '',
  (id) => {
    expanded.value = new Set()
    error.value = ''
    void loadMessages(id)
  },
  { immediate: true }
)

// 别处增删改该会话的消息落盘：重拉当前会话（调试视图要照见最新落盘）；
// 父层（SessionHistoryTab）另有自己的订阅管列表，两边互不代劳
useDataSync('conversation', () => {
  const id = props.conversation?.id
  if (id) void loadMessages(id)
})

async function refresh(): Promise<void> {
  const id = props.conversation?.id
  if (id) await loadMessages(id)
}

function toggleRaw(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function toggleAllRaw(): void {
  expanded.value = expanded.value.size ? new Set() : new Set(messages.value.map((m) => m.id))
}

// —— 导出：把选中会话的落盘原始记录下载为 .json（与「原始 JSON」逐字一致） ——
/** 文件名安全化：去掉文件系统非法字符、去首尾空白、截断到 60，避免标题带 / 或超长导致下载失败 */
function safeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60) || 'session'
}

/** 导出选中会话的落盘原始 JSON（会话元数据 + 全部消息），经 blob + a[download] 在本页触发下载，无需新增 manifest 权限 */
function exportConversation(): void {
  const conv = props.conversation
  if (!conv) return
  const payload = { conversation: conv, messages: messages.value }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `duoling-session-${safeFileName(conv.title)}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// —— 展示辅助 ——

/** 单条消息的 token 用量（usage 只落在 assistant 分支，模板里读它需要先判角色，故收成 helper） */
function usageTokens(m: Message): number | undefined {
  return m.role === 'assistant' ? m.usage?.totalTokens : undefined
}

/** 落盘字段概览：parts 里出现过哪些块类型（排查卡片 / 工具调用是否落库）。
 * `?? []` 只是防炸护栏：类型上 parts 必填，但库里可能还有旧记录（parts 缺失）。 */
function partTypes(m: Message): string[] {
  return [...new Set((m.parts ?? []).map((p) => p.type))]
}

/** 随消息落盘的拾取概览（排查 pageContext 是否真的进了库）；旧数据里的 snapshot 字段不再展示。
 * pageContext 只属于 user 分支，故先按 role 收窄。 */
function pageContextLabel(m: Message): string {
  const ctx = m.role === 'user' ? m.pageContext : undefined
  if (!ctx?.element) return ''
  const s = ctx.element.summary
  return `已点选 <${s.tag}${s.id ? '#' + s.id : ''}>`
}
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col" data-testid="conv-raw-view">
    <header class="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2 text-sm">
      <span class="truncate text-muted-foreground">
        {{ conversation ? `共 ${messages.length} 条消息` : '未选中会话' }}
      </span>
      <div v-if="conversation" class="flex shrink-0 items-center gap-2">
        <button
          type="button"
          class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          :disabled="messagesLoading"
          aria-label="重新读取"
          data-testid="conv-raw-refresh"
          @click="refresh()"
        >
          <ui-refresh-cw class="size-4" :class="{ 'animate-spin': messagesLoading }" />
        </button>
        <button
          v-if="messages.length"
          type="button"
          class="rounded-md px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          data-testid="conv-raw-export"
          @click="exportConversation()"
        >
          导出数据
        </button>
        <button
          v-if="messages.length"
          type="button"
          class="rounded-md px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          data-testid="conv-raw-toggle-all"
          @click="toggleAllRaw()"
        >
          {{ expanded.size ? '全部收起' : '展开全部' }}
        </button>
      </div>
    </header>

    <p v-if="error" class="m-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive" role="alert">
      {{ error }}
    </p>

    <div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
      <p v-if="messagesLoading" class="text-xs text-muted-foreground">读取中…</p>
      <template v-else>
        <article
          v-for="m in messages"
          :key="m.id"
          class="rounded-lg border border-border bg-card text-sm"
          :data-testid="`conv-raw-msg-${m.id}`"
        >
          <!-- 头部：角色 / 时间 / token / 落盘块类型 -->
          <div class="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground">
            <span
              class="rounded-full px-2 py-0.5"
              :class="m.role === 'user' ? 'bg-primary/10 text-foreground' : 'bg-muted text-muted-foreground'"
            >
              {{ m.role === 'user' ? '用户' : 'AI' }}
            </span>
            <span>{{ formatTimeWithSeconds(m.createdAt) }}</span>
            <span v-if="usageTokens(m)">· {{ usageTokens(m) }} tokens</span>
            <span v-if="partTypes(m).length" class="min-w-0 truncate" :title="partTypes(m).join('，')">
              · {{ partTypes(m).join('，') }}
            </span>
            <!-- 拾取落盘标记（本视图的核心排查点，有则高亮） -->
            <span
              v-if="pageContextLabel(m)"
              class="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-600"
              data-testid="conv-raw-page-context"
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
              :data-testid="`conv-raw-raw-${m.id}`"
              @click="toggleRaw(m.id)"
            >
              {{ expanded.has(m.id) ? '收起原始数据' : '原始数据' }}
            </button>
            <pre
              v-if="expanded.has(m.id)"
              class="mt-1.5 max-h-96 overflow-auto rounded-md bg-muted p-2 text-xs leading-relaxed"
            >{{ JSON.stringify(m, null, 2) }}</pre>
          </div>
        </article>
        <p v-if="!messages.length && conversation" class="text-xs text-muted-foreground">该会话暂无消息</p>
      </template>
    </div>
  </section>
</template>
