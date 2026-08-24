<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  Popover as UiPopover,
  PopoverContent as UiPopoverContent,
  PopoverTrigger as UiPopoverTrigger
} from '@/components/ui/popover'
import {
  Check as UiCheck,
  ChevronRight as UiChevronRight,
  ChevronsUpDown as UiChevronsUpDown,
  Plus as UiPlus
} from '@lucide/vue'

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

const emit = defineEmits<{ select: [taskId: number]; renamed: []; openSettings: [] }>()

// 在线模型状态：已配置（可直接对话）/ 未配置（需先设置）
const status = ref<'configured' | 'unconfigured'>('unconfigured')

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

// —— 模型连接状态：默认模型已配置且可用时为「已连接」——
interface ModelOption {
  id: string
  name: string
  hasApiKey: boolean
  enabled?: boolean
}

const profiles = ref<ModelOption[]>([])
const activeModelId = ref('')
// 模型下拉面板开关（常驻显示，点击触发按钮展开）
const modelMenuOpen = ref(false)

// 触发按钮显示的标签：未配置时显示「未配置」
const activeModelName = computed(
  () => profiles.value.find((p) => p.id === activeModelId.value)?.name ?? '未配置'
)

function refreshStatus(data: {
  profiles: Array<{
    id: string
    name: string
    baseUrl: string
    model: string
    hasApiKey: boolean
    enabled?: boolean
  }>
  activeId: string
}): void {
  // 主进程已把 activeId 规范化为「当前真正生效的启用模型」，前端直接以其为唯一真源
  const enabled = data.profiles.filter((p) => p.enabled !== false)
  profiles.value = enabled
  activeModelId.value = data.activeId
  const active = enabled.find((p) => p.id === activeModelId.value)
  status.value =
    active && active.baseUrl && active.model && active.hasApiKey ? 'configured' : 'unconfigured'
}

// 下拉面板内「添加模型」：关闭面板并跳转到设置页
function goToSettings(): void {
  modelMenuOpen.value = false
  emit('openSettings')
}

// 切换当前对话使用的模型（仅影响后续发送的请求）
async function switchModel(id: string): Promise<void> {
  if (!id || id === activeModelId.value) {
    modelMenuOpen.value = false
    return
  }
  try {
    await window.api.model.setActive(id)
    refreshStatus(await window.api.model.list())
  } catch (error) {
    console.error('切换模型失败：', error)
  } finally {
    modelMenuOpen.value = false
  }
}

onMounted(async () => {
  refreshStatus(await window.api.model.list())
  window.api.chat.onEvent(handleChatEvent)
})

onUnmounted(() => {
  window.api.chat.offEvent()
})

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
  if (!text || streaming.value || status.value !== 'configured') return
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
    </header>

    <div class="flex min-h-0 flex-1 flex-col">
      <div ref="scrollRef" class="min-h-0 flex-1 space-y-3 overflow-y-auto scroll-gap px-4 py-3">
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
              class="mt-1.5 whitespace-pre-wrap break-words"
            >
              {{ thinkOf(m) }}
            </div>
          </div>
          <!-- 消息气泡 -->
          <div
            class="max-w-[80%] min-w-0 break-words rounded-lg px-3 py-2 text-sm"
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

      <div
        v-if="status === 'unconfigured'"
        class="border-t px-4 py-2 text-xs text-muted-foreground"
      >
        未配置可用的在线模型，点击下方「未配置」，在列表中选择「添加模型」前往设置页
      </div>

      <div class="border-t p-3">
        <div
          class="rounded-md border border-input bg-transparent shadow-xs transition-[border,box-shadow] focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]"
        >
          <textarea
            ref="inputRef"
            v-model="input"
            rows="1"
            class="min-h-[78px] max-h-32 w-full resize-none overflow-y-auto scroll-gap bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50"
            placeholder="输入消息，回车发送，Shift+回车换行"
            :disabled="streaming || status !== 'configured'"
            @input="autoResizeInput"
            @keydown.enter.exact.prevent="sendMessage"
          />
          <!-- 底部工具栏：模型选择器 + 发送/停止按钮（右对齐，贴近参考图布局） -->
          <div class="flex items-center justify-end gap-2 px-2 pb-2">
            <ui-popover v-model:open="modelMenuOpen">
              <ui-popover-trigger as-child>
                <button
                  type="button"
                  class="flex h-7 max-w-[150px] items-center gap-1 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                  title="切换对话使用的模型"
                  aria-label="切换模型"
                >
                  <span class="truncate">{{ activeModelName }}</span>
                  <ui-chevrons-up-down class="size-3 shrink-0 text-muted-foreground" />
                </button>
              </ui-popover-trigger>
              <ui-popover-content class="w-60 p-1.5" align="start">
                <!-- 模型列表：有配置时逐条展示并支持勾选当前默认项 -->
                <div v-if="profiles.length" class="flex flex-col gap-0.5">
                  <button
                    v-for="p in profiles"
                    :key="p.id"
                    type="button"
                    class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
                    @click="switchModel(p.id)"
                  >
                    <span class="truncate">
                      {{ p.name }}{{ p.hasApiKey ? '' : '（缺 Key）' }}
                    </span>
                    <ui-check
                      v-if="p.id === activeModelId"
                      class="size-3.5 shrink-0 text-primary"
                    />
                  </button>
                </div>
                <!-- 未配置时：列表为空，仅显示空态提示 -->
                <p v-else class="px-2 py-1.5 text-xs text-muted-foreground">未配置模型</p>
                <!-- 底部「添加模型」：跳转到设置页自行添加 -->
                <div class="mt-1 border-t border-muted pt-1">
                  <button
                    type="button"
                    class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
                    @click="goToSettings"
                  >
                    <ui-plus class="size-3.5 shrink-0" />
                    添加模型
                  </button>
                </div>
              </ui-popover-content>
            </ui-popover>
            <div class="flex items-center gap-2">
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
                :disabled="streaming || status !== 'configured' || !input.trim()"
                @click="sendMessage"
              >
                发送
              </ui-button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
