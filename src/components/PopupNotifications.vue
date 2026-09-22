<script setup lang="ts">
// 工具栏 popup 的通知分区：正在生成的对话 + 跑完还没看的对话。
//
// 为什么明细放在这里：工具栏角标只有一个数字（它是全局那一份，说不清是什么事）—— 明细总得有
// 个能展开的地方，而「点开图标」这个动作天然就该是它。
//
// 与 PopupPageScripts 同姿势：直接 `chrome.runtime.sendMessage` 问 SW（popup 刻意不装 window.api，
// 它是纯配置面板）。**无通知时整块不渲染** —— 常态下 popup 保持原样，不新增噪音。
//
// 已读的那些不在这里展示：它们就是「刚看过的」，再列一遍没有信息量（库里留一份只是为了兜住
// 误点与将来要做历史）。
import { computed, onMounted, ref } from 'vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  FLOAT_OPEN_REQUEST,
  type AppNotification,
  type NotificationSnapshot,
  type RunningNotice,
  type RuntimeRequest,
  type RuntimeResponse,
} from '@/shared/extension-ipc'

const running = ref<RunningNotice[]>([])
const items = ref<AppNotification[]>([])

const unread = computed(() => items.value.filter((n) => n.readAt == null))
const hasAnything = computed(() => running.value.length > 0 || unread.value.length > 0)

async function send<T>(request: RuntimeRequest): Promise<T | undefined> {
  try {
    const res = (await chrome.runtime.sendMessage(request)) as RuntimeResponse<T> | undefined
    return res?.ok ? res.data : undefined
  } catch {
    // SW 不在（扩展正在更新 / 刚被禁用）时静默：popup 只是个面板，不必为它再弹一条错误
    return undefined
  }
}

async function refresh(): Promise<void> {
  const snapshot = await send<NotificationSnapshot>({ kind: 'notify:list' })
  if (!snapshot) return
  running.value = snapshot.running
  items.value = snapshot.items
}

/** 「刚刚 / N 分钟前 / N 小时前」——通知只关心新近程度，具体时刻没意义 */
function relativeTime(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/**
 * 跳到某个标签页的对话浮层：先把那个标签页翻到前台，再叫它展开浮层（契约定在 FloatOpenRequest）。
 * 返回 false = 那个标签页已经不在了（关掉过）或页面接不上，调用方另找落点。
 */
async function focusTab(tabId: number | null): Promise<boolean> {
  if (tabId == null) return false
  try {
    await chrome.tabs.update(tabId, { active: true })
    await chrome.tabs.sendMessage(tabId, FLOAT_OPEN_REQUEST)
    return true
  } catch {
    return false
  }
}

/** 兜底落点：标签页没了就把用户送到会话历史，别让这一下点击石沉大海 */
async function openSessions(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('workbench.html') + '#/sessions' })
}

async function openUnread(n: AppNotification): Promise<void> {
  await send({ kind: 'notify:read', id: n.id })
  if (!(await focusTab(n.tabId))) await openSessions()
  window.close()
}

/** 进行中的那条没有「已读」可言，点它就是去那个标签页看进度 */
async function openRunning(r: RunningNotice): Promise<void> {
  if (!(await focusTab(r.tabId))) await openSessions()
  window.close()
}

async function readAll(): Promise<void> {
  await send({ kind: 'notify:readAll' })
  await refresh()
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <div
    v-if="hasAnything"
    class="rounded-lg border border-border p-3"
    data-testid="popup-notifications"
  >
    <div class="flex items-center justify-between">
      <p class="text-sm font-medium">通知</p>
      <UiButton
        v-if="unread.length"
        variant="ghost"
        size="sm"
        class="h-6 px-2 text-xs"
        data-testid="notify-read-all"
        @click="readAll"
      >
        全部已读
      </UiButton>
    </div>

    <ul class="mt-1.5 flex flex-col">
      <li v-for="r in running" :key="`run-${r.conversationId}`">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left hover:bg-muted"
          data-testid="notify-running"
          @click="openRunning(r)"
        >
          <span class="size-1.5 shrink-0 rounded-full bg-primary" />
          <span class="min-w-0 flex-1 truncate text-xs font-medium">正在生成</span>
          <span v-if="r.host" class="shrink-0 text-xs text-muted-foreground">{{ r.host }}</span>
        </button>
      </li>

      <li v-for="n in unread" :key="n.id">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left hover:bg-muted"
          data-testid="notify-item"
          @click="openUnread(n)"
        >
          <span class="size-1.5 shrink-0 rounded-full bg-destructive" />
          <span class="min-w-0 flex-1 truncate text-xs font-medium">对话已完成</span>
          <span v-if="n.host" class="shrink-0 text-xs text-muted-foreground">{{ n.host }}</span>
          <span class="shrink-0 text-xs text-muted-foreground">{{ relativeTime(n.createdAt) }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
