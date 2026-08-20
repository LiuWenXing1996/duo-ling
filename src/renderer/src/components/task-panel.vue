<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ListTodo as UiListTodo, Trash2 as UiTrash2 } from '@lucide/vue'
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

const tasks = ref<Task[]>([])

// 当前打开删除确认弹窗的任务 id（null 表示全部关闭）
const deleteTargetId = ref<number | null>(null)
const deleteAllOpen = ref(false)

onMounted(async () => {
  try {
    tasks.value = await window.api.listTasks()
  } catch (error) {
    console.error('加载任务列表失败：', error)
  }
})

async function persistTasks(): Promise<void> {
  try {
    await window.api.saveTasks(tasks.value)
  } catch (error) {
    console.error('保存任务列表失败：', error)
  }
}

function onDeleteConfirmOpenChange(taskId: number, open: boolean) {
  deleteTargetId.value = open ? taskId : null
}

async function removeTask(id: number) {
  tasks.value = tasks.value.filter((task) => task.id !== id)
  deleteTargetId.value = null
  await persistTasks()
}

async function removeAll() {
  tasks.value = []
  deleteAllOpen.value = false
  await persistTasks()
}
</script>

<template>
  <section class="panel">
    <header class="panel-header flex items-center justify-between gap-2">
      <h2 class="panel-title flex items-center gap-2">
        <ui-list-todo class="size-4" />
        任务列表
      </h2>
      <ui-popover v-model:open="deleteAllOpen">
        <ui-tooltip>
          <ui-tooltip-trigger as-child>
            <ui-popover-trigger as-child>
              <ui-button
                variant="ghost"
                size="icon"
                class="size-7"
                :disabled="tasks.length === 0"
                aria-label="删除全部任务"
              >
                <ui-trash-2 class="size-3.5" />
              </ui-button>
            </ui-popover-trigger>
          </ui-tooltip-trigger>
          <ui-tooltip-content>删除全部</ui-tooltip-content>
        </ui-tooltip>
        <ui-popover-content class="w-60" align="end">
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

    <div class="min-h-0 flex-1 overflow-y-auto">
      <ul v-if="tasks.length > 0" class="divide-y">
        <li
          v-for="task in tasks"
          :key="task.id"
          class="group flex items-center justify-between gap-2 px-4 py-2.5"
        >
          <div class="min-w-0">
            <p class="truncate text-sm">{{ task.title }}</p>
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
