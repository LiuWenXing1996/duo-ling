<script setup lang="ts">
// 会话历史侧栏：工具内各会话的列表 + 新建 / 删除。删除确认使用「跟随点击位置的浮层」，
// 由本组件自含（避免在父组件 v-for 下产生多个定位浮层实例）。
import { computed, ref } from 'vue'
import { ListTodo as UiListTodo, Plus as UiPlus, Trash2 as UiTrash2 } from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import type { ToolSession } from '@/composables/use-tool-sessions'

const props = defineProps<{
  sessions: ToolSession[]
  activeSessionId: string
}>()
const emit = defineEmits<{
  activate: [id: string]
  new: []
  delete: [payload: { type: 'session' | 'all'; id?: string; title?: string }]
}>()

// —— 删除确认浮层：点击删除按钮时记录点击坐标与删除目标类型，浮层在点击处弹出 ——
// 单一浮层实例，避免为每个按钮各自挂 Popover、在 v-for 中产生多个实例导致定位/内容串扰。
const deleteConfirm = ref<
  { type: 'session' | 'all'; id?: string; title?: string; x: number; y: number } | null
>(null)

function openDelete(e: MouseEvent, target: { type: 'session' | 'all'; id?: string; title?: string }): void {
  e.stopPropagation()
  deleteConfirm.value = { ...target, x: e.clientX, y: e.clientY }
}

function cancelDelete(): void {
  deleteConfirm.value = null
}

function confirmDelete(): void {
  const t = deleteConfirm.value
  if (!t) return
  emit('delete', { type: t.type, id: t.id, title: t.title })
  deleteConfirm.value = null
}

// 浮层定位：跟随点击坐标，并钳制在视口内避免溢出
const confirmStyle = computed(() => {
  const t = deleteConfirm.value
  if (!t) return {}
  const x = Math.min(t.x + 8, window.innerWidth - 240)
  const y = Math.min(t.y + 8, window.innerHeight - 140)
  return { left: x + 'px', top: y + 'px' }
})
</script>

<template>
  <aside class="tool-sess panel">
    <header class="panel-header flex items-center justify-between gap-2">
      <h2 class="panel-title flex items-center gap-2">
        <ui-list-todo class="size-4" />
        会话历史
      </h2>
      <div class="flex items-center gap-1">
        <ui-button
          variant="ghost"
          size="icon"
          class="no-drag size-7"
          aria-label="删除全部会话"
          title="删除全部会话"
          :disabled="!props.sessions.length"
          @click="openDelete($event, { type: 'all' })"
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
      </div>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto scroll-gap">
      <ul v-if="props.sessions.length" class="divide-y">
        <li
          v-for="s in props.sessions"
          :key="s.id"
          class="group cursor-pointer px-4 py-2.5 transition-colors hover:bg-accent"
          :class="{ 'bg-accent': s.id === props.activeSessionId }"
          @click="emit('activate', s.id)"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="truncate text-sm">{{ s.title }}</p>
              <p class="text-muted-foreground text-xs">{{ s.meta }}</p>
            </div>
            <ui-button
              variant="ghost"
              size="icon"
              class="size-6 shrink-0 text-muted-foreground transition-colors hover:text-destructive no-drag"
              aria-label="删除该会话"
              title="删除该会话"
              @click="openDelete($event, { type: 'session', id: s.id, title: s.title })"
            >
              <ui-trash2 class="size-3.5" />
            </ui-button>
          </div>
        </li>
      </ul>
      <div v-else class="panel-body">
        <p class="panel-empty">暂无会话</p>
      </div>
    </div>

    <!-- 删除确认浮层：跟随点击位置弹出，type 决定文案与删除目标（单个 / 全部） -->
    <teleport to="body">
      <div v-if="deleteConfirm" class="fixed inset-0 z-50" @click="cancelDelete">
        <div
          class="bg-popover text-popover-foreground absolute w-56 rounded-md border p-3 shadow-md outline-none"
          :style="confirmStyle"
          @click.stop
        >
          <p class="text-xs">
            {{
              deleteConfirm.type === 'all'
                ? '确定删除所有会话吗？删除后全部聊天记录将不可恢复。'
                : `确定删除会话「${deleteConfirm.title}」吗？删除后聊天记录将不可恢复。`
            }}
          </p>
          <div class="mt-2 flex items-center justify-end gap-2">
            <ui-button variant="outline" size="sm" @click="cancelDelete">取消</ui-button>
            <ui-button variant="destructive" size="sm" @click="confirmDelete">删除</ui-button>
          </div>
        </div>
      </div>
    </teleport>
  </aside>
</template>
