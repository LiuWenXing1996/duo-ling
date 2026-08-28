<script setup lang="ts">
// 会话历史侧栏：工具内各会话的列表 + 新建 / 会话操作（重命名 / 删除）。
// 每项的「更多」下拉菜单包含重命名与删除；删除确认使用 UI 弹窗（Dialog），
// 重命名使用独立 Dialog + 输入框，均由本组件自含单一实例。
import { ref } from 'vue'
import {
  ListTodo as UiListTodo,
  MoreHorizontal as UiMoreHorizontal,
  Pencil as UiPencil,
  Plus as UiPlus,
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
import type { Conversation } from '../../../shared/types'
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

// —— 重命名弹窗：输入框预填当前标题，确认后 emit rename ——
const renameTarget = ref<{ id: string; title: string } | null>(null)
const renameOpen = ref(false)
const renameTitle = ref('')

function openRename(conv: Conversation): void {
  renameTarget.value = { id: conv.id, title: conv.title }
  renameTitle.value = conv.title
  renameOpen.value = true
}

function cancelRename(): void {
  renameOpen.value = false
}

function confirmRename(): void {
  const t = renameTarget.value
  const title = renameTitle.value.trim()
  if (!t || !title) return
  emit('rename', { id: t.id, title })
  renameOpen.value = false
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
      </div>
    </header>

    <!-- 列表容器：scroll-gap 仅给右侧留 3px 空隙（滚动条贴边保护），这里补 border-l 与左侧对称 -->
    <div class="min-h-0 flex-1 overflow-y-auto scroll-gap border-l-[3px] border-l-transparent">
      <ul v-if="props.conversations.length" class="divide-y">
        <li
          v-for="s in props.conversations"
          :key="s.id"
          class="group cursor-pointer px-4 py-2.5 transition-colors hover:bg-accent"
          :class="{ 'bg-accent': s.id === props.activeConversationId }"
          @click="emit('activate', s.id)"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="truncate text-sm">{{ s.title }}</p>
              <p class="text-muted-foreground text-xs">
                {{ formatSessionTime(s.lastMessageAt) }}<template v-if="s.totalTokens"
                  ><span class="mx-1">·</span>{{ s.totalTokens }} tokens</template
                >
              </p>
            </div>
            <ui-dropdown-menu>
              <ui-dropdown-menu-trigger as-child>
                <ui-button
                  variant="ghost"
                  size="icon"
                  class="size-6 shrink-0 text-muted-foreground transition-colors no-drag"
                  aria-label="会话操作"
                  title="会话操作"
                  @click.stop
                >
                  <ui-more-horizontal class="size-3.5" />
                </ui-button>
              </ui-dropdown-menu-trigger>
              <ui-dropdown-menu-content align="end" class="min-w-[120px]">
                <ui-dropdown-menu-item @click.stop="openRename(s)">
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
          </div>
        </li>
      </ul>
      <div v-else class="panel-body">
        <p class="panel-empty">暂无会话</p>
      </div>
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
