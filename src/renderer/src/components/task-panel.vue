<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ListTodo as UiListTodo, Plus as UiPlus, Trash2 as UiTrash2 } from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  Popover as UiPopover,
  PopoverContent as UiPopoverContent,
  PopoverTrigger as UiPopoverTrigger
} from '@/components/ui/popover'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipTrigger as UiTooltipTrigger
} from '@/components/ui/tooltip'

interface Task {
  id: number
  title: string
  createdAt: string
}

// 当前选中的会话（任务）id，由 App.vue 管理
const props = defineProps<{ activeTaskId?: number | null; sessionsVersion?: number }>()

const emit = defineEmits<{ select: [taskId: number | null] }>()

const tasks = ref<Task[]>([])

// 当前打开删除确认弹窗的任务 id（null 表示全部关闭）
const deleteTargetId = ref<number | null>(null)
const deleteAllOpen = ref(false)

// 标题内联编辑态（手动改名）
const editingId = ref<number | null>(null)
const editTitle = ref('')

function startEdit(task: Task): void {
  editingId.value = task.id
  editTitle.value = task.title
}

async function confirmRename(): Promise<void> {
  const id = editingId.value
  if (id == null) return
  editingId.value = null
  const trimmed = editTitle.value.trim()
  if (!trimmed) return
  try {
    await window.api.renameTask(id, trimmed)
    tasks.value = tasks.value.map((t) => (t.id === id ? { ...t, title: trimmed } : t))
  } catch (error) {
    console.error('重命名失败：', error)
  }
}

// 删除全部按钮的 DOM 引用：作为 popover 显式锚点（按钮被 tooltip 包裹时，context 锚点会归属 tooltip 的 PopperRoot）
const deleteAllBtnRef = ref<InstanceType<typeof UiButton> | null>(null)
const popoverReference = computed<HTMLElement | undefined>(() => (deleteAllBtnRef.value?.$el as HTMLElement | undefined) ?? undefined)

onMounted(async () => {
  try {
    tasks.value = await window.api.listTasks()
  } catch (error) {
    console.error('加载任务列表失败：', error)
  }
})

// 会话列表版本变化（如首条消息自动命名）时重新拉取
watch(
  () => props.sessionsVersion,
  async () => {
    try {
      tasks.value = await window.api.listTasks()
    } catch (error) {
      console.error('刷新会话列表失败：', error)
    }
  }
)

// 选中项不在本地列表时（如聊天面板自动新建），重新拉取；仍不存在则取消选中。
// 只监听 activeTaskId 变化、不监听 tasks，避免与删除时的保存操作产生读旧数据竞态
watch(
  () => props.activeTaskId,
  async (id) => {
    if (id == null || tasks.value.some((task) => task.id === id)) return
    try {
      const latest = await window.api.listTasks()
      tasks.value = latest
      if (!latest.some((task) => task.id === id)) {
        emit('select', null)
      }
    } catch (error) {
      console.error('刷新会话列表失败：', error)
    }
  },
  { immediate: true }
)

async function createSession(): Promise<void> {
  try {
    const task = await window.api.createTask()
    tasks.value = [...tasks.value, task]
    emit('select', task.id)
  } catch (error) {
    console.error('新建会话失败：', error)
  }
}

async function persistTasks(): Promise<void> {
  try {
    // IPC 传参必须是纯字面量：响应式 Proxy 数组无法被 Electron 结构化克隆
    await window.api.saveTasks(JSON.parse(JSON.stringify(tasks.value)) as Task[])
  } catch (error) {
    console.error('保存任务列表失败：', error)
  }
}

function onDeleteConfirmOpenChange(taskId: number, open: boolean) {
  deleteTargetId.value = open ? taskId : null
}

async function removeTask(id: number) {
  tasks.value = tasks.value.filter((task) => task.id !== id)
  if (props.activeTaskId === id) emit('select', null)
  deleteTargetId.value = null
  await persistTasks()
}

async function removeAll() {
  tasks.value = []
  if (props.activeTaskId != null) emit('select', null)
  deleteAllOpen.value = false
  await persistTasks()
}
</script>

<template>
  <section class="panel">
    <header class="panel-header flex items-center justify-between gap-2">
      <div class="flex items-center gap-1">
        <h2 class="panel-title flex items-center gap-2">
          <ui-list-todo class="size-4" />
          会话记录
        </h2>
        <ui-tooltip>
          <ui-tooltip-trigger as-child>
            <ui-button
              variant="ghost"
              size="icon"
              class="no-drag size-7"
              aria-label="新建会话"
              @click="createSession"
            >
              <ui-plus class="size-4" />
            </ui-button>
          </ui-tooltip-trigger>
          <ui-tooltip-content>新建会话</ui-tooltip-content>
        </ui-tooltip>
      </div>
      <ui-popover v-model:open="deleteAllOpen">
        <ui-tooltip :disabled="deleteAllOpen">
          <ui-tooltip-trigger as-child>
            <ui-popover-trigger as-child>
              <ui-button
                ref="deleteAllBtnRef"
                variant="ghost"
                size="icon"
                class="no-drag size-7"
                :disabled="tasks.length === 0"
                aria-label="删除全部任务"
              >
                <ui-trash-2 class="size-3.5" />
              </ui-button>
            </ui-popover-trigger>
          </ui-tooltip-trigger>
          <ui-tooltip-content>删除全部</ui-tooltip-content>
        </ui-tooltip>
        <ui-popover-content class="w-60" align="end" :reference="popoverReference">
          <p class="text-sm">确认删除全部任务？</p>
          <div class="mt-3 flex justify-end gap-2">
            <ui-button variant="outline" size="sm" @click="deleteAllOpen = false">
              取消
            </ui-button>
            <ui-button variant="destructive" size="sm" @click="removeAll">删除</ui-button>
          </div>
        </ui-popover-content>
      </ui-popover>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto py-1">
      <ul v-if="tasks.length > 0" class="divide-y">
        <li
          v-for="task in tasks"
          :key="task.id"
          class="task-item group relative flex cursor-pointer items-center justify-between gap-2 px-3 py-2 transition-colors hover:bg-accent/50"
          :class="{ 'bg-accent/60': props.activeTaskId === task.id }"
          :aria-selected="props.activeTaskId === task.id"
          @click="emit('select', task.id)"
        >
          <div class="min-w-0">
            <input
              v-if="editingId === task.id"
              v-model="editTitle"
              class="w-full rounded border px-1.5 py-0.5 text-sm outline-none focus-visible:border-ring"
              @keyup.enter="confirmRename"
              @keyup.esc="editingId = null"
              @blur="confirmRename"
            />
            <p
              v-else
              class="truncate text-sm"
              :title="task.title"
              @dblclick.stop="startEdit(task)"
            >
              {{ task.title }}
            </p>
            <p class="text-muted-foreground text-xs">{{ task.createdAt }}</p>
          </div>
          <ui-popover
            :open="deleteTargetId === task.id"
            @update:open="onDeleteConfirmOpenChange(task.id, $event)"
          >
            <ui-popover-trigger as-child>
              <ui-button
                variant="ghost"
                size="icon"
                class="size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                aria-label="删除任务"
                @click.stop
              >
                <ui-trash-2 class="size-3.5" />
              </ui-button>
            </ui-popover-trigger>
            <ui-popover-content class="w-60" align="end">
              <p class="text-sm">确认删除「{{ task.title }}」？</p>
              <div class="mt-3 flex justify-end gap-2">
                <ui-button variant="outline" size="sm" @click="deleteTargetId = null">
                  取消
                </ui-button>
                <ui-button variant="destructive" size="sm" @click="removeTask(task.id)">
                  删除
                </ui-button>
              </div>
            </ui-popover-content>
          </ui-popover>
        </li>
      </ul>
      <div v-else class="panel-body">
        <p class="panel-empty">暂无任务</p>
      </div>
    </div>
  </section>
</template>
