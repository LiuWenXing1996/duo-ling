<script setup lang="ts">
// 当前会话聊天区：消息气泡 + 思考过程折叠 + 变更清单留痕卡片 + 输入区 + 模型选择。
// 发送 / 停止 / 应用 / 放弃由父组件执行（涉及跨面板的会话写回与工具页落盘），
// 模型选择与打字机展示为纯本地面板逻辑，自含于此。
import { computed, onMounted, ref } from 'vue'
import {
  Check as UiCheck,
  ChevronRight as UiChevronRight,
  ChevronsUpDown as UiChevronsUpDown,
  Plus as UiPlus
} from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  Popover as UiPopover,
  PopoverContent as UiPopoverContent,
  PopoverTrigger as UiPopoverTrigger
} from '@/components/ui/popover'
import { truncate } from '@/lib/format'
import { isContractAnswer, splitContent } from '@/lib/message-format'
import type { PendingChange, ToolChatMessage } from '@/composables/use-tool-sessions'

const props = defineProps<{
  messages: ToolChatMessage[]
  pendingMap: Record<string, PendingChange>
  typing: Record<string, number>
  streaming: boolean
  draft: ToolChatMessage | null
}>()
const emit = defineEmits<{
  send: [text: string]
  stop: []
  applyPending: [messageId: string]
  discardPending: [messageId: string]
  openSettings: []
}>()

// —— 发送输入：内容仅本面板使用，发送时由父组件执行生成 ——
const input = ref('')

// —— 对话模型选择：仅切换后续发送所用的模型 ——
interface ModelOption {
  id: string
  name: string
  hasApiKey: boolean
  enabled?: boolean
}

const profiles = ref<ModelOption[]>([])
const activeModelId = ref('')
const modelMenuOpen = ref(false)
const activeModelName = computed(
  () => profiles.value.find((p) => p.id === activeModelId.value)?.name ?? '未配置'
)

function refreshModelStatus(data: {
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
  const enabled = data.profiles.filter((p) => p.enabled !== false)
  profiles.value = enabled
  activeModelId.value = data.activeId
}

async function switchModel(id: string): Promise<void> {
  if (!id || id === activeModelId.value) {
    modelMenuOpen.value = false
    return
  }
  try {
    await window.api.model.setActive(id)
    refreshModelStatus(await window.api.model.list())
  } catch (error) {
    console.error('切换模型失败：', error)
  } finally {
    modelMenuOpen.value = false
  }
}

function goToSettings(): void {
  modelMenuOpen.value = false
  emit('openSettings')
}

onMounted(() => {
  void window.api.model.list().then(refreshModelStatus)
})

// —— 思考过程可视化：把 <think>...</think> 拆为「思考内容」与「答案」两部分 ——
const thinkOf = (m: ToolChatMessage): string => splitContent(m.content).think

// 折叠式思考过程：记录已展开的消息 id（默认折叠）
const expandedThink = ref<Set<string>>(new Set())
function toggleThink(id: string): void {
  const next = new Set(expandedThink.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedThink.value = next
}

/** 消息正文：已完成的非契约正文用打字机逐字显示；流式契约 JSON 用「正在思考…」遮挡 */
function answerOf(m: ToolChatMessage): string {
  const raw = splitContent(m.content).answer
  if (isContractAnswer(raw)) return '正在思考…'
  const n = props.typing[m.id]
  return n != null ? raw.slice(0, n) : raw
}

/** 取某条 AI 消息挂载的变更卡片（可能不存在，如自动模式或无变更） */
function pendingOf(messageId: string): PendingChange | undefined {
  return props.pendingMap[messageId]
}

function onSend(): void {
  const text = input.value.trim()
  if (!text || props.streaming) return
  input.value = ''
  emit('send', text)
}
</script>

<template>
  <section class="tool-chat panel">
    <header class="panel-header flex items-center justify-between gap-2">
      <h2 class="panel-title">当前会话</h2>
    </header>

    <div class="flex min-h-0 flex-1 flex-col">
      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto scroll-gap px-4 py-3">
        <div v-if="props.messages.length === 0" class="flex h-full items-center justify-center">
          <p class="panel-empty">描述需求，AI 会重写这个工具页面</p>
        </div>
        <div
          v-for="m in props.messages"
          :key="m.id"
          class="flex flex-col gap-1.5"
          :class="m.role === 'user' ? 'items-end' : 'items-start'"
        >
          <!-- 思考过程：独立卡片，与回复气泡分开（仅 AI 且有实际思考内容时显示） -->
          <div
            v-if="m.role === 'ai' && thinkOf(m)"
            class="max-w-[80%] rounded-lg border border-muted bg-background/60 px-3 py-2 text-xs text-muted-foreground"
          >
            <button class="flex items-center gap-0.5 text-xs text-muted-foreground" @click="toggleThink(m.id)">
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
            :class="m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'"
          >
            <template v-if="m.role === 'user'">{{ m.content }}</template>
            <template v-else>
              {{ answerOf(m) || (props.draft && props.draft.id === m.id ? '正在思考…' : '') }}
            </template>
          </div>
          <!-- 变更清单留痕卡片：AI 产出改动后落盘留痕，每条消息保留独立卡片 -->
          <div
            v-if="m.role === 'ai' && pendingOf(m.id)"
            class="max-w-[80%] rounded-lg border border-border bg-background/60 px-3 py-2"
            data-testid="change-card"
          >
            <p class="text-xs font-medium">
              {{ pendingOf(m.id)?.changes.summary || 'AI 建议对当前工具做以下改动' }}
            </p>
            <ul class="mt-1.5 space-y-1 text-xs text-muted-foreground">
              <li v-for="(a, i) in pendingOf(m.id)?.changes.actions ?? []" :key="i">
                <span class="font-mono">{{ a.op }}</span> {{ a.file }}
                <template v-if="a.op === 'patch' && a.find">：{{ truncate(a.find) }}…</template>
              </li>
            </ul>
            <!-- 应用失败提示 -->
            <p
              v-if="pendingOf(m.id)?.error"
              class="mt-1.5 text-xs text-destructive"
              data-testid="change-error"
            >
              {{ pendingOf(m.id)?.error }}
            </p>
            <div class="mt-2 flex items-center gap-2">
              <template v-if="pendingOf(m.id)?.status === 'pending'">
                <ui-button size="sm" @click="emit('applyPending', m.id)">应用</ui-button>
                <ui-button
                  size="sm"
                  variant="outline"
                  :disabled="props.streaming"
                  @click="emit('discardPending', m.id)"
                >
                  放弃
                </ui-button>
              </template>
              <span v-else-if="pendingOf(m.id)?.status === 'applied'" class="text-xs text-green-600">
                已应用到当前工具
              </span>
              <span v-else class="text-xs text-muted-foreground">已放弃本次改动</span>
            </div>
          </div>
        </div>
      </div>

      <div class="border-t p-3">
        <div class="rounded-md border border-input bg-transparent shadow-xs transition-[border,box-shadow] focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]">
          <textarea
            v-model="input"
            rows="1"
            class="min-h-[78px] max-h-32 w-full resize-none overflow-y-auto scroll-gap bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50"
            placeholder="例如：做一个能读取本地文件并用 Markdown 展示的工具"
            :disabled="props.streaming"
            @keydown.enter.exact.prevent="onSend"
          />
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
                    <ui-check v-if="p.id === activeModelId" class="size-3.5 shrink-0 text-primary" />
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
            <ui-button v-if="props.streaming" variant="outline" size="sm" @click="emit('stop')">
              停止
            </ui-button>
            <ui-button size="sm" :disabled="props.streaming || !input.trim()" @click="onSend">
              发送
            </ui-button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
