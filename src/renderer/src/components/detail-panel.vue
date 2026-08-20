<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronDown, ChevronRight, Cpu, FileText, MessageSquare, Sparkles } from '@lucide/vue'

interface Task {
  id: number
  title: string
  createdAt: string
}

interface LlamaStatus {
  state: 'idle' | 'loading' | 'ready' | 'error'
  modelPath: string | null
  modelExists: boolean
  gpu?: string
  error?: string
}

const props = defineProps<{ activeTaskId?: number | null }>()

const collapsed = ref<Set<string>>(new Set())

function toggle(id: string): void {
  const next = new Set(collapsed.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsed.value = next
}

function isOpen(id: string): boolean {
  return !collapsed.value.has(id)
}

const status = ref<LlamaStatus>({ state: 'idle', modelPath: null, modelExists: false })
const tasks = ref<Task[]>([])

const statusTextMap: Record<LlamaStatus['state'], string> = {
  idle: '未加载',
  loading: '加载中…',
  ready: '就绪',
  error: '加载失败'
}

const statusClass = computed(() => {
  switch (status.value.state) {
    case 'ready': return 'bg-emerald-500/10 text-emerald-600'
    case 'loading': return 'bg-amber-500/10 text-amber-600'
    case 'error': return 'bg-red-500/10 text-red-600'
    default: return 'bg-muted text-muted-foreground'
  }
})

const activeTask = computed<Task | null>(() => {
  if (props.activeTaskId == null) return null
  return tasks.value.find((t) => t.id === props.activeTaskId) ?? null
})

async function refresh(): Promise<void> {
  try {
    status.value = await window.api.llama.init()
    tasks.value = await window.api.listTasks()
  } catch (error) {
    console.error('加载详情失败：', error)
  }
}

onMounted(refresh)

watch(
  () => props.activeTaskId,
  async () => {
    if (tasks.value.length === 0) {
      try {
        tasks.value = await window.api.listTasks()
      } catch (error) {
        console.error('刷新任务列表失败：', error)
      }
    }
  }
)
</script>

<template>
  <section class="panel">
    <header class="panel-header">
      <h2 class="panel-title">会话详情</h2>
    </header>

    <div class="flex-1 overflow-y-auto py-2">
      <!-- 会话信息 -->
      <div v-if="isOpen('session')" class="px-4 pb-3">
        <button
          class="no-drag flex w-full items-center gap-1.5 py-1 text-xs font-semibold text-muted-foreground"
          @click="toggle('session')"
        >
          <component :is="ChevronDown" class="size-3" />
          <component :is="MessageSquare" class="size-3.5" />
          会话信息
        </button>
        <div class="mt-2 space-y-1.5 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5 text-xs">
          <template v-if="activeTask">
            <div class="flex justify-between">
              <span class="text-muted-foreground">标题</span>
              <span class="max-w-[160px] truncate font-medium" :title="activeTask.title">
                {{ activeTask.title }}
              </span>
            </div>
            <div class="flex justify-between">
              <span class="text-muted-foreground">ID</span>
              <span>{{ activeTask.id }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-muted-foreground">创建时间</span>
              <span>{{ activeTask.createdAt }}</span>
            </div>
          </template>
          <template v-else>
            <p class="py-1 text-center text-muted-foreground">未选中会话</p>
          </template>
        </div>
      </div>

      <!-- 模型状态 -->
      <div v-if="isOpen('model')" class="px-4 pb-3">
        <button
          class="no-drag flex w-full items-center gap-1.5 py-1 text-xs font-semibold text-muted-foreground"
          @click="toggle('model')"
        >
          <component :is="ChevronDown" class="size-3" />
          <component :is="Cpu" class="size-3.5" />
          模型状态
        </button>
        <div class="mt-2 space-y-1.5 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5 text-xs">
          <div class="flex items-center justify-between">
            <span class="text-muted-foreground">状态</span>
            <span
              class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
              :class="statusClass"
            >
              {{ statusTextMap[status.state] }}
            </span>
          </div>
          <div v-if="status.modelPath" class="flex justify-between">
            <span class="text-muted-foreground">GPU</span>
            <span>{{ status.gpu ?? 'CPU' }}</span>
          </div>
          <div v-if="status.modelPath" class="flex justify-between">
            <span class="text-muted-foreground">模型</span>
            <span class="max-w-[140px] truncate" :title="status.modelPath.split('/').pop()">
              {{ status.modelPath.split('/').pop() }}
            </span>
          </div>
        </div>
      </div>

      <!-- 上下文 -->
      <div class="px-4 pb-3">
        <button
          class="no-drag flex w-full items-center gap-1.5 py-1 text-xs font-semibold text-muted-foreground"
          @click="toggle('context')"
        >
          <component :is="ChevronDown" v-if="isOpen('context')" class="size-3" />
          <component :is="ChevronRight" v-else class="size-3" />
          <component :is="Sparkles" class="size-3.5" />
          上下文
        </button>
        <div v-if="isOpen('context')" class="mt-2 space-y-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5">
          <p class="text-xs text-muted-foreground">暂无上下文记录</p>
          <div class="flex items-center gap-2 rounded border border-border/40 px-2 py-1.5 text-[11px] text-muted-foreground">
            <FileText class="size-3" />
            <span>会话历史（对话消息将在模型加载后自动填充）</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
