<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Button as UiButton } from '@/components/ui/button'
import { Badge as UiBadge } from '@/components/ui/badge'
import { ChevronRight as UiChevronRight } from '@lucide/vue'

interface LlamaStatus {
  state: 'idle' | 'loading' | 'ready' | 'error'
  modelPath: string | null
  modelExists: boolean
  gpu?: string
  error?: string
}

interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

type ChatEvent =
  | { type: 'token'; taskId: number; token: string }
  | { type: 'done'; taskId: number; message: ChatMessage }
  | { type: 'aborted'; taskId: number; message: ChatMessage | null }
  | { type: 'error'; taskId: number; error: string }

const props = defineProps<{ activeTaskId?: number | null }>()

const emit = defineEmits<{ select: [taskId: number]; renamed: [] }>()

const statusTextMap: Record<LlamaStatus['state'], string> = {
  idle: '未加载',
  loading: '加载中…',
  ready: '就绪',
  error: '加载失败'
}

const status = ref<LlamaStatus>({ state: 'idle', modelPath: null, modelExists: false })
const messages = ref<ChatMessage[]>([])
const input = ref('')
const streaming = ref(false)
const errorText = ref('')
// 当前正在流式生成中的草稿消息
const draft = ref<ChatMessage | null>(null)
const scrollRef = ref<HTMLElement | null>(null)
// 多行输入框：最小高度（3 行）由 CSS 类 min-h-[78px] 控制；最大高度（px，约 5 行），超过则出现滚动条
const inputRef = ref<HTMLTextAreaElement | null>(null)
const INPUT_MAX_HEIGHT = 128

function autoResizeInput(): void {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto'
  // scrollHeight 不含上下 border，而 height（border-box）含 border；
  // 直接赋值会少算 border 高度，内容溢出导致出现滚动条
  const border = el.offsetHeight - el.clientHeight
  const next = Math.min(el.scrollHeight + border, INPUT_MAX_HEIGHT)
  el.style.height = `${next}px`
}

// 拆分「思考过程」与「最终答案」：<think>...</think> 为思考内容，其余为答案
// 模型有时输出空思考（如 <think>\n\n</think>），trim 后为空视为无思考，不展示按钮
function splitContent(content: string): { think: string; answer: string } {
  const open = content.indexOf('<think>')
  if (open === -1) return { think: '', answer: content.trim() }
  const rest = content.slice(open + '<think>'.length)
  const close = rest.indexOf('</think>')
  if (close === -1) return { think: rest.trim(), answer: '' }
  return { think: rest.slice(0, close).trim(), answer: rest.slice(close + '</think>'.length).trim() }
}

const thinkOf = (m: ChatMessage): string => splitContent(m.content).think
const answerOf = (m: ChatMessage): string => splitContent(m.content).answer

// 折叠式思考过程：记录已展开的消息 id（默认折叠）
const expandedThink = ref<Set<number>>(new Set())
function toggleThink(id: number): void {
  const next = new Set(expandedThink.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedThink.value = next
}

function scrollToBottom(): void {
  void nextTick(() => {
    const el = scrollRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

async function loadHistory(): Promise<void> {
  if (streaming.value) return
  messages.value = []
  draft.value = null
  streaming.value = false
  expandedThink.value = new Set()
  const taskId = props.activeTaskId
  if (taskId == null) return
  try {
    messages.value = await window.api.chat.history(taskId)
  } catch (error) {
    console.error('加载会话历史失败：', error)
  }
}

// immediate：挂载时若已有选中会话，立即加载历史
watch(() => props.activeTaskId, loadHistory, { immediate: true })

onMounted(async () => {
  // 挂载后尝试自动加载模型（模型缺失时返回错误状态，引导用户放置模型文件）
  status.value = await window.api.llama.init()
  window.api.chat.onEvent(handleChatEvent)
})

onUnmounted(() => {
  window.api.chat.offEvent()
})

async function loadModel() {
  status.value = await window.api.llama.init()
}

function handleChatEvent(payload: ChatEvent): void {
  if (payload.taskId !== props.activeTaskId) return
  const currentDraft = draft.value

  if (payload.type === 'token') {
    if (currentDraft) {
      currentDraft.content += payload.token
      scrollToBottom()
    }
  } else if (payload.type === 'done' || payload.type === 'aborted') {
    streaming.value = false
    if (currentDraft) {
      if (payload.message) {
        currentDraft.id = payload.message.id
        currentDraft.content = payload.message.content
        currentDraft.createdAt = payload.message.createdAt
      } else {
        messages.value = messages.value.filter((m) => m.id !== currentDraft.id)
      }
      draft.value = null
    }
    scrollToBottom()
  } else if (payload.type === 'error') {
    streaming.value = false
    if (currentDraft) {
      messages.value = messages.value.filter((m) => m.id !== currentDraft.id)
      draft.value = null
    }
    errorText.value = payload.error
  }
}

async function sendMessage(): Promise<void> {
  const text = input.value.trim()
  if (!text || streaming.value || status.value.state !== 'ready') return
  // 提前清空输入框：连按回车/双击时第二次触发读到空文本直接返回，避免重复创建会话
  input.value = ''
  void nextTick(autoResizeInput)

  // 未选中会话时：首条消息自动新建会话并选中
  let taskId = props.activeTaskId
  if (taskId == null) {
    try {
      const task = await window.api.createTask()
      taskId = task.id
      emit('select', task.id)
    } catch (error) {
      console.error('自动新建会话失败：', error)
      return
    }
  }

  errorText.value = ''
  const now = new Date().toISOString()
  messages.value.push({ id: Date.now(), role: 'user', content: text, createdAt: now })
  // 首条消息：主进程会按消息内容自动命名会话，通知左侧刷新
  const wasFirstMessage = messages.value.length === 1
  const draftMessage: ChatMessage = { id: Date.now(), role: 'assistant', content: '', createdAt: now }
  messages.value.push(draftMessage)
  draft.value = draftMessage
  streaming.value = true
  scrollToBottom()

  try {
    // 流式 token 通过 chat:event 推送，这里等待生成结束
    await window.api.chat.send(taskId, text)
  } catch (error) {
    streaming.value = false
    console.error('发送消息失败：', error)
  }
  if (wasFirstMessage) emit('renamed')
}

async function stopGeneration(): Promise<void> {
  await window.api.chat.abort()
}
</script>

<template>
  <section class="panel">
    <header class="panel-header flex items-center justify-between gap-2">
      <h2 class="panel-title">对话框</h2>
      <div class="flex items-center gap-2">
        <ui-badge :variant="status.state === 'ready' ? 'default' : 'secondary'">
          {{ statusTextMap[status.state] }}
        </ui-badge>
        <ui-button
          variant="ghost"
          size="sm"
          class="no-drag h-7 px-2 text-xs"
          :disabled="status.state === 'loading' || status.state === 'ready'"
          @click="loadModel"
        >
          加载模型
        </ui-button>
      </div>
    </header>

    <div class="flex min-h-0 flex-1 flex-col">
      <div ref="scrollRef" class="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <div v-if="!activeTaskId" class="flex h-full items-center justify-center">
          <p class="panel-empty">未选中会话，直接输入消息将自动新建</p>
        </div>
        <div v-else-if="messages.length === 0" class="flex h-full items-center justify-center">
          <p class="panel-empty">发送一条消息开始对话</p>
        </div>
        <div
          v-for="m in messages"
          :key="m.id"
          class="flex flex-col gap-1.5"
          :class="m.role === 'user' ? 'items-end' : 'items-start'"
        >
          <!-- 思考过程：独立卡片，与回复气泡分开（仅 assistant 且有实际思考内容时显示） -->
          <div
            v-if="m.role === 'assistant' && thinkOf(m)"
            class="max-w-[80%] rounded-lg border border-muted bg-background/60 px-3 py-2 text-xs text-muted-foreground"
          >
            <button
              class="flex items-center gap-0.5 text-xs text-muted-foreground"
              @click="toggleThink(m.id)"
            >
              <ui-chevron-right
                class="size-3 transition-transform"
                :class="{ 'rotate-90': expandedThink.has(m.id) }"
              />
              思考过程
            </button>
            <div
              v-show="expandedThink.has(m.id)"
              data-testid="think-body"
              class="mt-1.5 whitespace-pre-wrap"
            >
              {{ thinkOf(m) }}
            </div>
          </div>
          <!-- 消息气泡 -->
          <div
            class="max-w-[80%] rounded-lg px-3 py-2 text-sm"
            :class="
              m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
            "
          >
            <template v-if="m.role === 'user'">{{ m.content }}</template>
            <template v-else>
              {{ answerOf(m) || (streaming && m === draft ? '思考中…' : '') }}
            </template>
          </div>
        </div>
        <p v-if="errorText" class="text-destructive text-xs">{{ errorText }}</p>
      </div>

      <div v-if="status.state === 'error'" class="border-t px-4 py-2 text-xs text-destructive">
        {{ status.error }}
      </div>
      <div
        v-else-if="!status.modelExists"
        class="border-t px-4 py-2 text-xs text-muted-foreground"
      >
        将 MiniCPM5-1B-Q8_0.gguf 放入 llm-models/ 目录后点击「加载模型」
      </div>

      <div class="border-t p-3">
        <div class="relative">
          <textarea
            ref="inputRef"
            v-model="input"
            rows="1"
            class="min-h-[78px] max-h-32 w-full resize-none overflow-y-auto rounded-md border border-input bg-transparent px-3 py-2 pr-32 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50"
            placeholder="输入消息，回车发送，Shift+回车换行"
            :disabled="streaming || status.state !== 'ready'"
            @input="autoResizeInput"
            @keydown.enter.exact.prevent="sendMessage"
          />
          <!-- 发送/停止按钮悬浮在输入框右下角内部（相对 textarea 定位，避免伸出框外） -->
          <div class="absolute bottom-2 right-2 flex items-center gap-2">
            <ui-button
              v-if="streaming"
              variant="outline"
              size="sm"
              @click="stopGeneration"
            >
              停止
            </ui-button>
            <ui-button
              size="sm"
              :disabled="streaming || status.state !== 'ready' || !input.trim()"
              @click="sendMessage"
            >
              发送
            </ui-button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
