<script setup lang="ts">
// 当前会话聊天区：消息气泡 + 思考/工具过程折叠 + 变更清单留痕卡片 + 输入区 + 模型选择。
// 发送 / 停止由父组件执行，AI 产出变更后纯自动落盘（卡片仅作留痕展示，无手动应用/放弃）；
// 模型选择为纯本地面板逻辑，自含于此。
//
// 方案 B（切进 AI SDK 全家桶）后：消息模型为 UIMessage（parts），渲染按
//   - text part      -> 消息气泡正文（MessageResponse）
//   - reasoning part -> 思考与执行过程中的思考段落
//   - tool part      -> 工具调用卡（ToolHeader + ToolInput + ToolOutput）
// 按 parts 出现顺序交错成「思考与执行过程」链，移除旧 chainNodes / reasonings 结构。
import { computed, onMounted, ref } from 'vue'
import {
  Brain as UiBrain,
  Check as UiCheck,
  ChevronsUpDown as UiChevronsUpDown,
  CircleCheck as UiCircleCheck,
  CircleX as UiCircleX,
  FileText as UiFileText,
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
  ChainOfThought as UiChainOfThought,
  ChainOfThoughtContent as UiChainOfThoughtContent,
  ChainOfThoughtHeader as UiChainOfThoughtHeader,
  ChainOfThoughtStep as UiChainOfThoughtStep
} from '@/components/ai-elements/chain-of-thought'
import {
  Tool as UiTool,
  ToolContent as UiToolContent,
  ToolHeader as UiToolHeader,
  ToolInput as UiToolInput,
  ToolOutput as UiToolOutput
} from '@/components/ai-elements/tool'
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
import type { PendingChange } from '@/composables/use-global-conversation'
import {
  getToolName,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage
} from 'ai'

const props = defineProps<{
  messages: UIMessage[]
  pendingMap: Record<string, PendingChange>
  streaming: boolean
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

// —— 消息渲染：UIMessage parts -> 气泡正文 / 思考与执行过程 ——

/** 把消息的 text parts 聚合为正文（流式多轮正文按出现顺序拼接） */
function textOf(m: UIMessage): string {
  return m.parts.filter(isTextUIPart).map((p) => p.text).join('')
}

/** 用户消息正文：直接聚合 text parts 展示 */
function userText(m: UIMessage): string {
  return textOf(m)
}

/** 消息角色映射：ai-elements 的 Message 用 'user' | 'assistant' */
function fromOf(m: UIMessage): 'user' | 'assistant' {
  return m.role === 'user' ? 'user' : 'assistant'
}

const lastMessageId = computed(() => props.messages[props.messages.length - 1]?.id)

/** 最终答案正文：最后一个 text part（中间轮正文已按步骤归入链，此处仅剩最终回复） */
function finalText(m: UIMessage): string {
  const textParts = m.parts.filter(isTextUIPart)
  return textParts.length ? textParts[textParts.length - 1].text : ''
}

/** 消息正文：取最终 text part；流式且尚无正文时给占位，避免空白气泡 */
function assistantText(m: UIMessage): string {
  const t = finalText(m)
  if (t.trim()) return t
  return m.id === lastMessageId.value && props.streaming ? '正在思考…' : '（无回复内容）'
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

// —— 思考与执行过程：把 reasoning / tool parts 按序交错成链 ——
type ToolState = ToolUIPart['state'] | DynamicToolUIPart['state']

interface ThinkingNode {
  kind: 'thinking'
  key: string
  /** 思考轮次序号（Agent Loop 中每轮调用工具前后的思考各占一段） */
  round: number
  text: string
}
interface ToolNode {
  kind: 'tool'
  key: string
  /** 工具 part 的 type（本项目全部为静态 tool，形如 tool-agent_tools_list） */
  partType: ToolUIPart['type']
  state: ToolState
  name: string
  title: string
  input: unknown
  output: unknown
  errorText?: string
}
interface TextNode {
  kind: 'text'
  key: string
  /** 中间轮正文步骤序号（与思考/工具步骤连续编号，便于阅读） */
  round: number
  /** 中间轮正文：模型在调用工具前后输出的叙述，作为链上独立一环（最终答案留在主气泡） */
  text: string
}
type ProcessNode = ThinkingNode | ToolNode | TextNode

/** 从工具 output 提取错误文案：AI SDK 工具返回对象 { ok:false, error } 时归入 Error 分支 */
function extractToolError(output: unknown): string | undefined {
  if (output && typeof output === 'object' && !Array.isArray(output) && 'ok' in output) {
    const rec = output as { ok?: unknown; error?: unknown }
    if (rec.ok === false) return typeof rec.error === 'string' ? rec.error : '工具执行失败'
  }
  return undefined
}

/** 把工具 part 归一化为可渲染的节点（名称/标题/入参/出参/错误） */
function buildToolNode(part: ToolUIPart | DynamicToolUIPart, key: string): ToolNode {
  const name = getToolName(part)
  return {
    kind: 'tool',
    key,
    partType: part.type as ToolUIPart['type'],
    state: part.state,
    name,
    title: part.title ?? stepLabel(name),
    input: part.input,
    output: part.output,
    errorText: part.errorText ?? extractToolError(part.output)
  }
}

/** 是否存在可折叠的「思考与执行过程」（至少一个 reasoning / tool / 中间轮正文 part；最终 text part 不算过程） */
function hasProcess(m: UIMessage): boolean {
  return processNodes(m).length > 0
}

/** 把推理与工具调用按 parts 顺序交错成链式节点（中间轮正文也作为独立一环） */
function processNodes(m: UIMessage): ProcessNode[] {
  const nodes: ProcessNode[] = []
  let i = 0
  let round = 0
  let textRound = 0
  const textParts = m.parts.filter(isTextUIPart)
  const lastTextPart = textParts[textParts.length - 1]
  for (const part of m.parts) {
    if (isReasoningUIPart(part) && part.text.trim()) {
      round += 1
      nodes.push({ kind: 'thinking', key: `r-${i++}`, round, text: part.text })
    } else if (isTextUIPart(part) && part !== lastTextPart && part.text.trim()) {
      textRound += 1
      nodes.push({ kind: 'text', key: `x-${i++}`, round: textRound, text: part.text })
    } else if (isToolUIPart(part)) {
      nodes.push(buildToolNode(part, `t-${i++}`))
    }
  }
  return nodes
}

/** 工具步骤状态 → ChainOfThoughtStep 步骤状态（入参流式生成中视为 active，其余视为完成） */
function stepStatus(state: ToolState): 'complete' | 'active' {
  return state === 'input-streaming' ? 'active' : 'complete'
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
              <!-- 思考与执行过程：思考段落与 tool 卡按 parts 顺序交错成链（每节点独立一环），默认展开 -->
              <ui-chain-of-thought
                v-if="m.role === 'assistant' && hasProcess(m)"
                :default-open="true"
                class="w-full min-w-0"
                data-testid="chain-of-thought"
              >
                <ui-chain-of-thought-header>思考与执行过程</ui-chain-of-thought-header>
                <ui-chain-of-thought-content>
                  <template v-for="node in processNodes(m)" :key="node.key">
                    <!-- 思考节点：该轮模型在调用工具前后的思考，按轮单独一环展示 -->
                    <ui-chain-of-thought-step
                      v-if="node.kind === 'thinking'"
                      :label="`思考 ${node.round}`"
                      class="w-full min-w-0"
                    >
                      <template #icon>
                        <ui-brain class="size-4 shrink-0 text-muted-foreground" />
                      </template>
                      <ui-message-response
                        :content="node.text"
                        class="max-h-64 overflow-y-auto rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm leading-relaxed text-foreground/90 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1 [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"
                      />
                    </ui-chain-of-thought-step>
                    <!-- 工具调用节点：官方 Tool 卡片（入参 ToolInput + 出参/报错 ToolOutput）嵌进链上这一环 -->
                    <ui-chain-of-thought-step
                      v-else-if="node.kind === 'tool'"
                      :label="node.title"
                      :status="stepStatus(node.state)"
                      class="w-full min-w-0"
                    >
                      <template #icon>
                        <ui-loader-circle
                          v-if="node.state === 'input-streaming'"
                          class="size-4 shrink-0 animate-spin text-muted-foreground"
                        />
                        <ui-circle-x
                          v-else-if="node.errorText"
                          class="size-4 shrink-0 text-destructive"
                        />
                        <ui-circle-check v-else class="size-4 shrink-0 text-green-600" />
                      </template>
                      <ui-tool class="min-w-0" :default-open="true">
                        <ui-tool-header
                          :type="node.partType"
                          :state="node.state"
                          :title="node.title"
                        />
                        <ui-tool-content class="min-w-0">
                          <ui-tool-input v-if="node.input != null" :input="node.input" />
                          <ui-tool-output :output="node.output" :error-text="node.errorText" />
                        </ui-tool-content>
                      </ui-tool>
                    </ui-chain-of-thought-step>
                    <!-- 正文步骤：中间轮叙述（非最终答案），作为链上独立一环，复用 Markdown 渲染 -->
                    <ui-chain-of-thought-step
                      v-else
                      :label="`步骤 ${node.round}`"
                      class="w-full min-w-0"
                    >
                      <template #icon>
                        <ui-file-text class="size-4 shrink-0 text-muted-foreground" />
                      </template>
                      <ui-message-response
                        :content="node.text"
                        class="max-h-64 overflow-y-auto rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm leading-relaxed text-foreground/90 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1 [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"
                      />
                    </ui-chain-of-thought-step>
                  </template>
                </ui-chain-of-thought-content>
              </ui-chain-of-thought>
              <!-- 消息气泡：用 ai-elements 的 Message / MessageContent / MessageResponse 渲染 -->
              <ui-message :from="fromOf(m)" class="max-w-full">
                <template v-if="m.role === 'user'">
                  <ui-message-content>{{ userText(m) }}</ui-message-content>
                </template>
                <template v-else>
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
                v-if="m.role === 'assistant' && pendingOf(m.id)"
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
