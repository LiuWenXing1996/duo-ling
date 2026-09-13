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
import { computed, onMounted, reactive, ref } from 'vue'
import {
  Check as UiCheck,
  ChevronsDown as UiChevronsDown,
  ChevronsUpDown as UiChevronsUpDown,
  CircleCheck as UiCircleCheck,
  CircleX as UiCircleX,
  FileText as UiFileText,
  LoaderCircle as UiLoaderCircle,
  Plus as UiPlus,
  Sparkle as UiSparkle
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
import { Shimmer as UiShimmer } from '@/components/ai-elements/shimmer'
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
import type { TokenUsage } from '@/shared/types'
import {
  getToolName,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  type DynamicToolUIPart,
  type TextUIPart,
  type ToolUIPart,
  type UIMessage
} from 'ai'

const props = defineProps<{
  messages: UIMessage[]
  pendingMap: Record<string, PendingChange>
  /** 各消息本次消耗的 token（按 UIMessage.id 索引），assistant 消息展示在气泡下方 */
  usageByMessageId: Record<string, TokenUsage>
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

/** 最终答案 text part：消息最后一段 text；若其后仍有任何后续内容（reasoning/tool/text/step-start）则视为尚未完成 */
function finalTextPart(m: UIMessage): TextUIPart | undefined {
  const textParts = m.parts.filter(isTextUIPart)
  if (!textParts.length) return undefined
  const last = textParts[textParts.length - 1]
  const lastIndex = m.parts.indexOf(last)
  // 已过内容边界的 text 一定是中间正文：后面还有 reasoning/tool/text/新 step，
  // 它不再是最终答案候选（避免中间正文在气泡中闪现）
  const hasContentAfter = m.parts
    .slice(lastIndex + 1)
    .some((p) => isReasoningUIPart(p) || isToolUIPart(p) || isTextUIPart(p) || p.type === 'step-start')
  return hasContentAfter ? undefined : last
}

/** 最终答案正文：最后一个 text part（中间轮正文已按步骤归入链，此处仅剩最终回复） */
function finalText(m: UIMessage): string {
  return finalTextPart(m)?.text ?? ''
}

/** 消息正文：流式进行中不实时展示正文（避免中间正文闪现进气泡），结束后按最终答案展示 */
function assistantText(m: UIMessage): string {
  // 流式中的最后一条消息：正文可能仍是中间轮内容，先给占位，结束后才显示最终答案
  if (m.id === lastMessageId.value && props.streaming) return '正在思考…'
  const t = finalText(m)
  return t.trim() ? t : '（无回复内容）'
}

/** 取某条 AI 消息挂载的变更卡片（可能不存在，如自动模式或无变更） */
function pendingOf(messageId: string): PendingChange | undefined {
  return props.pendingMap[messageId]
}

/** 取某条消息本次消耗的 token（assistant 气泡下方展示） */
function usageOf(messageId: string): TokenUsage | undefined {
  return props.usageByMessageId[messageId]
}

/** 简短 token 展示：优先 totalTokens，回退到 input+output 之和；无数据返回空串 */
function tokenLabel(usage: TokenUsage | undefined): string {
  if (!usage) return ''
  const total =
    usage.totalTokens ??
    (usage.inputTokens != null && usage.outputTokens != null
      ? usage.inputTokens + usage.outputTokens
      : undefined)
  return total == null ? '' : `${total} tokens`
}

/** Agent 工具调用步骤的中文展示名（未识别的能力名直接回显） */
function stepLabel(name: string): string {
  if (name === 'agent_tools_list') return '查询工具列表'
  if (name === 'agent_tools_open') return '打开工具'
  if (name === 'agent_capabilities_list') return '查询能力清单'
  return name
}

// —— 思考与执行过程：把 reasoning / tool / 中间正文按 parts 顺序交错成链 ——
type ToolState = ToolUIPart['state'] | DynamicToolUIPart['state']

interface ThinkingNode {
  kind: 'thinking'
  key: string
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
  /** 中间轮正文：模型在调用工具前后输出的叙述，作为链上独立一环（最终答案留在主气泡） */
  text: string
}
interface ContinueNode {
  kind: 'continue'
  key: string
  /** step 边界提示节点：新 step 开始时的「继续流程」过渡 */
}
type ProcessNode = ThinkingNode | ToolNode | TextNode | ContinueNode

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

/** 是否存在可折叠的「思考过程」（至少一个 reasoning / tool / 中间轮正文 / step 边界；最终 text part 不算过程） */
function hasProcess(m: UIMessage): boolean {
  return processNodes(m).length > 0
}

/** 把推理与工具调用按 parts 顺序交错成链式节点（step-start 处插入「继续流程」节点；链首 step-start 不渲染） */
function processNodes(m: UIMessage): ProcessNode[] {
  const nodes: ProcessNode[] = []
  let i = 0
  const final = finalTextPart(m)
  for (const part of m.parts) {
    if (part.type === 'step-start') {
      // 首个 step-start 是第一个 step 的开始（非 step 之间），不渲染「继续流程」
      if (nodes.length > 0) nodes.push({ kind: 'continue', key: `c-${i++}` })
    } else if (isReasoningUIPart(part) && part.text.trim()) {
      nodes.push({ kind: 'thinking', key: `r-${i++}`, text: part.text })
    } else if (isTextUIPart(part) && part !== final && part.text.trim()) {
      nodes.push({ kind: 'text', key: `x-${i++}`, text: part.text })
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

// —— 长内容折叠：思考 / 说明按字符数近似判定超长，截断 + 「展开全部」，可手动展开/收起 ——
// 说明：不用 DOM 高度测量（外层「思考过程」折叠时内部不可见、scrollHeight 测不到），
// 改用字符数近似，无可见性依赖、流式稳定。
/** 折叠阈值（字符数）：超过即视为长内容（近似对应 160px 高度） */
const COLLAPSE_CHAR_THRESHOLD = 300

/** 用户已手动展开的思考节点 key 集合（key = `${messageId}:${node.key}`） */
const expandedThinks = reactive(new Set<string>())
/** 用户已手动展开的说明节点 key 集合 */
const expandedTexts = reactive(new Set<string>())

/** 思考节点是否超长（字符数近似） */
function isThinkLong(node: ThinkingNode): boolean {
  return node.text.length > COLLAPSE_CHAR_THRESHOLD
}

/** 说明节点是否超长（字符数近似） */
function isTextLong(node: TextNode): boolean {
  return node.text.length > COLLAPSE_CHAR_THRESHOLD
}

/** 该思考是否处于折叠态（超长且未展开） */
function thinkCollapsed(m: UIMessage, node: ThinkingNode): boolean {
  return isThinkLong(node) && !expandedThinks.has(`${m.id}:${node.key}`)
}

/** 该说明是否处于折叠态（超长且未展开） */
function textCollapsed(m: UIMessage, node: TextNode): boolean {
  return isTextLong(node) && !expandedTexts.has(`${m.id}:${node.key}`)
}

/** 切换长思考的展开/收起 */
function toggleThink(m: UIMessage, node: ThinkingNode): void {
  const key = `${m.id}:${node.key}`
  if (expandedThinks.has(key)) expandedThinks.delete(key)
  else expandedThinks.add(key)
}

/** 切换长说明的展开/收起 */
function toggleText(m: UIMessage, node: TextNode): void {
  const key = `${m.id}:${node.key}`
  if (expandedTexts.has(key)) expandedTexts.delete(key)
  else expandedTexts.add(key)
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
            description="说点什么，开始对话吧"
          />
          <template v-else>
            <div
              v-for="m in props.messages"
              :key="m.id"
              class="flex flex-col gap-1.5"
              :class="m.role === 'user' ? 'items-end' : 'items-start'"
            >
              <!-- 思考过程：思考/说明/工具卡按 parts 顺序交错成链，默认折叠 -->
              <ui-chain-of-thought
                v-if="m.role === 'assistant' && hasProcess(m)"
                :default-open="false"
                class="w-full min-w-0"
                data-testid="chain-of-thought"
              >
                <ui-chain-of-thought-header>思考过程</ui-chain-of-thought-header>
                <ui-chain-of-thought-content class="pl-4">
                  <template v-for="node in processNodes(m)" :key="node.key">
                    <!-- step 边界「继续流程」节点 -->
                    <ui-chain-of-thought-step
                      v-if="node.kind === 'continue'"
                      label="继续流程"
                      class="w-full min-w-0"
                    >
                      <template #icon>
                        <ui-chevrons-down class="size-4 shrink-0 text-muted-foreground" />
                      </template>
                      <!-- 占位：保持节点有内容高度，左侧竖向连接线得以贯穿上下 -->
                      <div class="h-4" />
                    </ui-chain-of-thought-step>
                    <!-- 思考节点：弱化灰 + 超长截断折叠（展开态 overflow-x-auto 防长代码撑宽） -->
                    <ui-chain-of-thought-step
                      v-else-if="node.kind === 'thinking'"
                      label="思考"
                      class="w-full min-w-0"
                    >
                      <template #icon>
                        <ui-sparkle class="size-4 shrink-0 text-muted-foreground" />
                      </template>
                      <div
                        :class="[
                          'relative w-fit min-w-0 max-w-full',
                          thinkCollapsed(m, node)
                            ? 'max-h-40 overflow-hidden'
                            : 'overflow-x-auto',
                        ]"
                      >
                        <ui-message-response
                          :content="node.text"
                          class="text-sm leading-relaxed text-muted-foreground/70! [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1 [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"
                        />
                        <!-- 折叠遮罩：底部淡出，营造内容被「盖住」的效果 -->
                        <div
                          v-if="thinkCollapsed(m, node)"
                          class="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-background to-transparent"
                        />
                      </div>
                      <button
                        v-if="isThinkLong(node)"
                        type="button"
                        class="mt-1 inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-muted/70"
                        @click="toggleThink(m, node)"
                      >
                        {{ expandedThinks.has(`${m.id}:${node.key}`) ? '收起' : '展开' }}
                      </button>
                    </ui-chain-of-thought-step>
                    <!-- 工具调用节点：Tool 自带折叠（header 点击展开/收起），默认收起，展开后全文 -->
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
                      <ui-tool class="min-w-0" :default-open="false">
                        <ui-tool-header
                          :type="node.partType"
                          :state="node.state"
                          :title="node.title"
                        />
                        <ui-tool-content class="max-h-none min-w-0">
                          <ui-tool-input v-if="node.input != null" :input="node.input" />
                          <ui-tool-output :output="node.output" :error-text="node.errorText" />
                        </ui-tool-content>
                      </ui-tool>
                    </ui-chain-of-thought-step>
                    <!-- 说明节点（中间轮正文）：与思考一致，弱化灰 + 超长截断折叠 -->
                    <ui-chain-of-thought-step
                      v-else
                      label="说明"
                      class="w-full min-w-0"
                    >
                      <template #icon>
                        <ui-file-text class="size-4 shrink-0 text-muted-foreground" />
                      </template>
                      <div
                        :class="[
                          'relative w-fit min-w-0 max-w-full',
                          textCollapsed(m, node)
                            ? 'max-h-40 overflow-hidden'
                            : 'overflow-x-auto',
                        ]"
                      >
                        <ui-message-response
                          :content="node.text"
                          class="text-sm leading-relaxed text-muted-foreground/70! [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1 [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"
                        />
                        <!-- 折叠遮罩：底部淡出，营造内容被「盖住」的效果 -->
                        <div
                          v-if="textCollapsed(m, node)"
                          class="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-background to-transparent"
                        />
                      </div>
                      <button
                        v-if="isTextLong(node)"
                        type="button"
                        class="mt-1 inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-muted/70"
                        @click="toggleText(m, node)"
                      >
                        {{ expandedTexts.has(`${m.id}:${node.key}`) ? '收起' : '展开' }}
                      </button>
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
                    <!-- 流式中：Shimmer 占位，不展示可能还会变化的正文（避免中间正文闪现） -->
                    <ui-shimmer
                      v-if="m.id === lastMessageId && props.streaming"
                      class="text-sm"
                    >
                      正在思考…
                    </ui-shimmer>
                    <ui-message-response
                      v-else
                      :content="assistantText(m)"
                      class="[&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1 [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"
                    />
                  </ui-message-content>
                </template>
              </ui-message>
              <!-- 本次消耗 token：assistant 气泡下方展示（无 usage 时不渲染） -->
              <p
                v-if="m.role === 'assistant' && tokenLabel(usageOf(m.id))"
                class="pl-1 text-xs text-muted-foreground/70"
                title="本次回复消耗的 token"
                data-testid="message-tokens"
              >
                {{ tokenLabel(usageOf(m.id)) }}
              </p>
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
