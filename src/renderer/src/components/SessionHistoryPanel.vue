<script setup lang="ts">
// 会话历史侧栏：工具内各会话的列表 + 新建 / 删除。删除确认使用 UI 弹窗（Dialog），
// 由本组件自含单一实例，避免在父组件 v-for 下产生多个弹窗。
import { ref } from 'vue'
import { ListTodo as UiListTodo, Plus as UiPlus, Trash2 as UiTrash2 } from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  Dialog as UiDialog,
  DialogContent as UiDialogContent,
  DialogDescription as UiDialogDescription,
  DialogFooter as UiDialogFooter,
  DialogTitle as UiDialogTitle
} from '@/components/ui/dialog'
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
              @click.stop="openDelete({ type: 'session', id: s.id, title: s.title })"
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
