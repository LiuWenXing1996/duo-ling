<script setup lang="ts">
import { computed, ref } from 'vue'
import { Button as UiButton } from '@/components/ui/button'
import { runCapability } from '@/lib/capability-runner'
import {
  ChevronRight as UiChevronRight,
  ChevronsUpDown as UiChevronsUpDown,
  ListTodo as UiListTodo,
  PanelRightClose as UiPanelRightClose,
  Play as UiPlay,
  Plus as UiPlus
} from '@lucide/vue'

// 单个工具页的占位数据模型（会话记录 / 对话框 / 会话详情）
export interface ToolSession {
  id: string
  status: 'doing' | 'done' | 'rollback'
  title: string
  meta: string
}

export interface ToolChatMessage {
  id: string
  role: 'ai' | 'user'
  content: string
  meta?: string
}

export interface ToolFile {
  name: string
  size: string
  done: boolean
}

export interface Tool {
  id: string
  name: string
  taskLabel: string
  status: string
  costTime: string
  costMode: 'local' | 'mixed'
  modelName: string
  // 工具界面（拖放/选项/输出）配置，供后续受控宿主使用
  inputTitle: string
  inputHint: string
  files?: ToolFile[]
  optLabel?: string
  optOptions?: string[]
  optActive?: string
  outputLabel?: string
  outputValue?: string
  sessions: ToolSession[]
  chat: ToolChatMessage[]
  capabilities: string[]
  previewText: string
  costNote?: string
  // 真实能力演示：Markdown 渲染器的默认输入内容（复用 `docs.markdown.render` 前端能力）
  mdSource?: string
}

const props = defineProps<{ tool: Tool }>()

// 会话 / 对话为本地占位状态：切换会话、新建会话、发送消息仅在前端演示
const sessions = ref<ToolSession[]>([...props.tool.sessions])
const activeSessionId = ref(props.tool.sessions[0]?.id ?? '')
const messages = ref<ToolChatMessage[]>([...props.tool.chat])
const input = ref('')

// 真实能力演示：复用 `docs.markdown.render` 前端能力，在工具页内直接渲染 Markdown
const mdInput = ref(props.tool.mdSource ?? '# 小班\n\n输入 Markdown，点「运行」查看 HTML 预览。\n\n- 标题\n- 列表\n- 代码块')
const mdHtml = ref('')
const mdError = ref('')
const mdRunning = computed(() => props.tool.capabilities.includes('docs.markdown.render'))

async function runMarkdown(): Promise<void> {
  mdError.value = ''
  mdHtml.value = ''
  const res = await runCapability('docs.markdown.render', { markdown: mdInput.value })
  if (res.ok) {
    mdHtml.value = (res.result as { html: string }).html
  } else {
    mdError.value = res.error
  }
}

// 三栏宽度：左右两栏可通过分隔条拖拽调节
const sessWidth = ref(300)
const detailWidth = ref(340)
const MIN_WIDTH = 220
const MAX_WIDTH = 480

function startResize(e: MouseEvent, side: 'sess' | 'detail'): void {
  e.preventDefault()
  const startX = e.clientX
  const startWidth = side === 'sess' ? sessWidth.value : detailWidth.value
  const onMove = (ev: MouseEvent): void => {
    const dx = ev.clientX - startX
    const next = side === 'sess' ? startWidth + dx : startWidth - dx
    const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next))
    if (side === 'sess') sessWidth.value = clamped
    else detailWidth.value = clamped
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

const activeSession = () => sessions.value.find((s) => s.id === activeSessionId.value)

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function newSession(): void {
  const id = `s-${Date.now()}`
  const session: ToolSession = {
    id,
    status: 'doing',
    title: '未命名会话',
    meta: formatDate(new Date())
  }
  sessions.value.push(session)
  activeSessionId.value = id
}

function send(): void {
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  messages.value.push({ id: `u-${Date.now()}`, role: 'user', content: text })
  // 占位回复：真实实现会接入对话链路
  messages.value.push({
    id: `a-${Date.now()}`,
    role: 'ai',
    content: '已收到，这是占位回复。真实实现将调用编排链路执行该工具。'
  })
}
</script>

<template>
  <div class="tool-page">
    <!-- 会话记录 -->
    <aside class="tool-sess panel" :style="{ width: sessWidth + 'px' }">
      <header class="panel-header flex items-center justify-between gap-2">
        <div class="flex items-center gap-1">
          <h2 class="panel-title flex items-center gap-2">
            <ui-list-todo class="size-4" />
            会话记录
          </h2>
          <ui-button
            variant="ghost"
            size="icon"
            class="no-drag size-7"
            aria-label="新建会话"
            @click="newSession"
          >
            <ui-plus class="size-4" />
          </ui-button>
        </div>
        <ui-button variant="ghost" size="icon" class="no-drag size-7" aria-label="收起工具会话">
          <ui-panel-right-close class="size-4" />
        </ui-button>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto scroll-gap">
        <ul v-if="sessions.length" class="divide-y">
          <li
            v-for="s in sessions"
            :key="s.id"
            class="cursor-pointer px-4 py-2.5 transition-colors hover:bg-accent"
            :class="{ 'bg-accent': s.id === activeSessionId }"
            @click="activeSessionId = s.id"
          >
            <p class="truncate text-sm">{{ s.title }}</p>
            <p class="text-muted-foreground text-xs">{{ s.meta }}</p>
          </li>
        </ul>
        <div v-else class="panel-body">
          <p class="panel-empty">暂无会话</p>
        </div>
      </div>
    </aside>

    <div
      class="tool-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="拖拽调整会话记录宽度"
      @mousedown="startResize($event, 'sess')"
    />

    <!-- 对话框 -->
    <section class="tool-chat panel">
      <header class="panel-header">
        <h2 class="panel-title">对话框</h2>
      </header>

      <div class="flex min-h-0 flex-1 flex-col">
        <div class="min-h-0 flex-1 space-y-3 overflow-y-auto scroll-gap px-4 py-3">
          <div v-if="messages.length === 0" class="flex h-full items-center justify-center">
            <p class="panel-empty">发送一条消息开始对话</p>
          </div>
          <div
            v-for="m in messages"
            :key="m.id"
            class="flex flex-col"
            :class="m.role === 'user' ? 'items-end' : 'items-start'"
          >
            <div
              class="max-w-[80%] rounded-lg px-3 py-2 text-sm"
              :class="m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'"
            >
              {{ m.content }}
            </div>
          </div>
        </div>

        <div class="border-t p-3">
          <div
            class="rounded-md border border-input bg-transparent shadow-xs transition-[border,box-shadow] focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]"
          >
            <textarea
              v-model="input"
              rows="1"
              class="min-h-[78px] max-h-32 w-full resize-none overflow-y-auto scroll-gap bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
              placeholder="输入消息，回车发送，Shift+回车换行"
              @keydown.enter.exact.prevent="send"
            />
            <div class="flex items-center justify-end gap-2 px-2 pb-2">
              <button
                type="button"
                class="flex h-7 max-w-[150px] items-center gap-1 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring"
                title="切换对话使用的模型"
                aria-label="切换模型"
              >
                <span class="truncate">{{ tool.modelName }}</span>
                <ui-chevrons-up-down class="size-3 shrink-0 text-muted-foreground" />
              </button>
              <ui-button size="sm" :disabled="!input.trim()" @click="send">
                发送
              </ui-button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <div
      class="tool-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="拖拽调整会话详情宽度"
      @mousedown="startResize($event, 'detail')"
    />

    <!-- 会话详情 -->
    <section class="tool-detail panel" :style="{ width: detailWidth + 'px' }">
      <header class="panel-header">
        <h2 class="panel-title">会话详情</h2>
      </header>

      <div v-if="activeSession()" class="min-h-0 flex-1 overflow-y-auto scroll-gap p-4">
        <div class="space-y-4">
          <div class="flex items-center gap-2">
            <h1 class="text-sm font-semibold">{{ tool.name }}</h1>
            <span class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-600">
              {{ tool.status }}
            </span>
          </div>

          <div class="space-y-1.5 text-xs">
            <div class="flex justify-between">
              <span class="text-muted-foreground">任务</span>
              <span>{{ tool.taskLabel }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-muted-foreground">耗时</span>
              <span>&lt;{{ tool.costTime }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-muted-foreground">运行模式</span>
              <span>{{ tool.costMode === 'local' ? '本机' : '联网' }}</span>
            </div>
          </div>

          <div>
            <p class="mb-1.5 font-mono text-[10px] text-muted-foreground">
              能力编排 · backend registry
            </p>
            <div
              v-for="(cap, i) in tool.capabilities"
              :key="cap"
              class="flex items-center gap-2 py-1 font-mono text-[11px]"
            >
              <span
                class="grid size-4 place-items-center rounded bg-primary text-[9px] text-primary-foreground"
              >
                {{ i + 1 }}
              </span>
              {{ cap }}
            </div>
          </div>

          <div v-if="mdRunning">
            <p class="mb-1.5 text-[11px] text-muted-foreground">Markdown 输入</p>
            <textarea
              v-model="mdInput"
              rows="6"
              class="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 font-mono text-xs outline-none focus-visible:border-ring placeholder:text-muted-foreground"
              placeholder="输入 Markdown…"
            />
            <p v-if="mdError" class="mt-2 text-xs text-red-500">{{ mdError }}</p>
          </div>

          <div>
            <p class="mb-1.5 text-[11px] text-muted-foreground">结果预览</p>
            <div
              class="grid h-24 place-items-center rounded-md border border-dashed border-border text-xs text-muted-foreground"
              :class="{ 'h-auto min-h-24 place-items-start p-3': mdHtml }"
            >
              <span v-if="mdHtml" v-html="mdHtml" class="prose-sm w-full" />
              <template v-else>{{ tool.previewText }}</template>
            </div>
          </div>

          <div
            v-if="tool.costNote"
            class="flex items-center gap-2 rounded-lg bg-amber-500/15 px-3 py-2 text-xs text-amber-700"
          >
            <ui-chevron-right class="size-3.5" />
            {{ tool.costNote }}
          </div>

          <ui-button class="w-full justify-center" @click="mdRunning ? runMarkdown() : undefined">
            <ui-play class="size-4" />运行
          </ui-button>
        </div>
      </div>
      <div v-else class="panel-body">
        <p class="panel-empty">暂无会话详情</p>
      </div>
    </section>
  </div>
</template>

<style scoped lang="less">
.tool-page {
  display: flex;
  height: 100%;
  min-height: 0;
}

.tool-divider {
  flex: none;
  position: relative;
  width: 6px;
  cursor: col-resize;
  background: transparent;

  &::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 2.5px;
    width: 1px;
    background: var(--border);
    transition: background-color 0.15s;
  }

  &:hover::after {
    background: var(--primary);
  }
}

.tool-sess,
.tool-detail {
  flex: none;
  min-width: 0;
}

.tool-chat {
  flex: 1;
  min-width: 0;
}
</style>
