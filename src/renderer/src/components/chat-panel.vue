<script setup lang="ts">
// 当前会话聊天区：消息气泡 + 思考过程折叠 + 变更清单留痕卡片 + 输入区 + 模型选择。
// 发送 / 停止由父组件执行，AI 产出变更后纯自动落盘（卡片仅作留痕展示，无手动应用/放弃）；
// 模型选择为纯本地面板逻辑，自含于此。
import { computed, onMounted, ref } from 'vue'
import {
  Brain as UiBrain,
  Check as UiCheck,
  ChevronDown as UiChevronDown,
  ChevronsUpDown as UiChevronsUpDown,
  CircleCheck as UiCircleCheck,
  CircleX as UiCircleX,
  LoaderCircle as UiLoaderCircle,
  Plus as UiPlus
} from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  Popover as UiPopover,
  PopoverContent as UiPopoverContent,
  PopoverTrigger as UiPopoverTrigger
} from '@/components/ui/popover'
import {
  Message as UiMessage,
  MessageContent as UiMessageContent,
  MessageResponse as UiMessageResponse
} from '@/components/ai-elements/message'
import {
  Reasoning as UiReasoning,
  ReasoningContent as UiReasoningContent,
  ReasoningTrigger as UiReasoningTrigger
} from '@/components/ai-elements/reasoning'
import {
  Conversation as UiConversation,
  ConversationContent as UiConversationContent,
  ConversationEmptyState as UiConversationEmptyState,
  ConversationScrollButton as UiConversationScrollButton
} from '@/components/ai-elements/conversation'
import {
  PromptInput as UiPromptInput,
  PromptInputFooter as UiPromptInputFooter,
  PromptInputSubmit as UiPromptInputSubmit,
  PromptInputTextarea as UiPromptInputTextarea,
  PromptInputTools as UiPromptInputTools
} from '@/components/ai-elements/prompt-input'
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input'
import { truncate } from '@/lib/format'
import type { PendingChange, ToolChatMessage } from '@/composables/use-tool-sessions'

const props = defineProps<{
  messages: ToolChatMessage[]
  pendingMap: Record<string, PendingChange>
  streaming: boolean
  draft: ToolChatMessage | null
}>()
const emit = defineEmits<{
  send: [text: string]
  stop: []
  openSettings: []
}>()

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

// —— 思考过程可视化：思考与正文从一开始就分离存（reasoning / content），直接读取即可 ——
const thinkOf = (m: ToolChatMessage): string => m.reasoning ?? ''

// 折叠式思考过程（ai-elements Reasoning 受控展开）：记录已展开的消息 id（默认折叠）
const expandedThink = ref<Set<string>>(new Set())
function setThinkOpen(id: string, open: boolean): void {
  const next = new Set(expandedThink.value)
  if (open) next.add(id)
  else next.delete(id)
  expandedThink.value = next
}

/** 消息角色映射：ai-elements 的 Message 用 UIMessage['role']，项目内 AI 用 'ai' */
function fromOf(m: ToolChatMessage): 'user' | 'assistant' {
  return m.role === 'user' ? 'user' : 'assistant'
}

/** 消息正文：直接读 m.content；流式草稿暂无正文时给一句占位，避免空白气泡。 */
function assistantText(m: ToolChatMessage): string {
  return m.content.trim() ? m.content : props.draft && props.draft.id === m.id ? '正在思考…' : '（无回复内容）'
}

/** 取某条 AI 消息挂载的变更卡片（可能不存在，如自动模式或无变更） */
function pendingOf(messageId: string): PendingChange | undefined {
  return props.pendingMap[messageId]
}

/** Agent 工具调用步骤的中文展示名（未识别的能力名直接回显） */
function stepLabel(name: string): string {
  if (name === 'agent_tools_list') return '查询工具列表'
  if (name === 'agent_tools_open') return '打开工具'
  return name
}

/** 发送/停止：由 PromptInput 表单提交触发；流式时视为停止，否则发送（执行由父组件负责） */
function onPromptSubmit(payload: PromptInputMessage): void {
  if (props.streaming) {
    emit('stop')
    return
  }
  const text = payload.text.trim()
  if (!text) return
  emit('send', text)
}
</script>

<template>
  <section class="tool-chat panel">
    <header class="panel-header flex items-center justify-between gap-2">
      <h2 class="panel-title">当前会话</h2>
    </header>

    <div class="flex min-h-0 flex-1 flex-col">
      <!-- 消息区：用 ai-elements Conversation 贴底滚动 + 滚动到底部按钮 -->
      <ui-conversation class="min-h-0 flex-1" aria-label="当前会话消息">
        <ui-conversation-content>
          <ui-conversation-empty-state
            v-if="props.messages.length === 0"
            title="暂无消息"
            description="描述需求，AI 会重写这个工具页面"
          />
          <template v-else>
            <div
              v-for="m in props.messages"
              :key="m.id"
              class="flex flex-col gap-1.5"
              :class="m.role === 'user' ? 'items-end' : 'items-start'"
            >
              <!-- 思考过程：用 ai-elements Reasoning 折叠展示（仅 AI 且有实际思考内容时显示） -->
              <ui-reasoning
                v-if="m.role === 'ai' && thinkOf(m)"
                :open="expandedThink.has(m.id)"
                :default-open="false"
                class="w-full min-w-0"
                @update:open="setThinkOpen(m.id, $event)"
              >
                <ui-reasoning-trigger class="text-sm">
                  <ui-brain class="size-4" />
                  思考过程
                  <ui-chevron-down
                    class="size-4 shrink-0 transition-transform"
                    :class="{ 'rotate-180': expandedThink.has(m.id) }"
                  />
                </ui-reasoning-trigger>
                <ui-reasoning-content :content="thinkOf(m)" data-testid="think-body" />
              </ui-reasoning>
              <!-- 消息气泡：用 ai-elements 的 Message / MessageContent / MessageResponse 渲染 -->
              <ui-message :from="fromOf(m)" class="max-w-full">
                <template v-if="m.role === 'user'">
                  <ui-message-content>{{ m.content }}</ui-message-content>
                </template>
                <template v-else>
                  <!-- Agent 工具调用步骤：AI 自主调用工具时逐步展示（查询/打开等） -->
                  <ul
                    v-if="m.steps?.length"
                    class="w-full min-w-0 space-y-1.5"
                    data-testid="agent-steps"
                  >
                    <li
                      v-for="s in m.steps"
                      :key="s.id"
                      class="flex items-start gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-xs"
                    >
                      <ui-loader-circle
                        v-if="s.status === 'running'"
                        class="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground"
                      />
                      <ui-circle-check
                        v-else-if="s.status === 'done'"
                        class="mt-0.5 size-3.5 shrink-0 text-green-600"
                      />
                      <ui-circle-x v-else class="mt-0.5 size-3.5 shrink-0 text-destructive" />
                      <div class="min-w-0 flex-1">
                        <p class="font-medium">{{ stepLabel(s.name) }}</p>
                        <p
                          v-if="s.arguments"
                          class="mt-0.5 truncate font-mono text-muted-foreground"
                        >
                          {{ s.arguments }}
                        </p>
                        <p v-if="s.error" class="mt-0.5 text-destructive">{{ s.error }}</p>
                      </div>
                    </li>
                  </ul>
                  <ui-message-content class="w-full min-w-0">
                    <ui-message-response
                      :content="assistantText(m)"
                      class="[&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1 [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"
                    />
                  </ui-message-content>
                </template>
              </ui-message>
              <!-- 变更清单留痕卡片：AI 产出改动后自动落盘留痕，仅作展示（无手动应用/放弃） -->
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
                <!-- 自动落盘成功状态 -->
                <p v-else class="mt-1.5 text-xs text-green-600">已自动应用到当前工具</p>
              </div>
            </div>
          </template>
        </ui-conversation-content>
        <ui-conversation-scroll-button />
      </ui-conversation>

      <div class="border-t p-3">
        <ui-prompt-input @submit="onPromptSubmit">
          <ui-prompt-input-textarea
            placeholder="例如：做一个能读取本地文件并用 Markdown 展示的工具"
            :disabled="props.streaming"
          />
          <ui-prompt-input-footer>
            <!-- 工具区：模型选择（保留富内容弹层：缺Key提示/空态/添加模型入口） -->
            <ui-prompt-input-tools>
            <ui-popover v-model:open="modelMenuOpen">
              <ui-popover-trigger as-child>
                <ui-button
                  type="button"
                  variant="outline"
                  size="xs"
                  class="max-w-[150px]"
                  title="切换对话使用的模型"
                  aria-label="切换模型"
                >
                  <span class="truncate">{{ activeModelName }}</span>
                  <ui-chevrons-up-down class="size-3 shrink-0 text-muted-foreground" />
                </ui-button>
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
            </ui-prompt-input-tools>
            <!-- 发送/停止：单个提交按钮，流式时依据 status 自动切换为停止图标 -->
            <ui-prompt-input-submit :status="props.streaming ? 'streaming' : undefined" />
          </ui-prompt-input-footer>
        </ui-prompt-input>
      </div>
    </div>
  </section>
</template>
