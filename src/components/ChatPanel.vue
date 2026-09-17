<script setup lang="ts">
// 当前会话聊天区：消息气泡 + 思考/工具过程折叠 + 输入区 + 模型选择。
// 发送 / 停止由父组件执行；模型选择为纯本地面板逻辑，自含于此。
// 2026-09-14：工具链路移除后，原「变更清单留痕卡片」
// （AI 产出多工具意图 → 自动落盘留痕）整段摘除。
//
// 方案 B（切进 AI SDK 全家桶）后：消息模型为 UIMessage（parts），渲染按
//   - text part      -> 消息气泡正文（MessageResponse）
//   - reasoning part -> 思考与执行过程中的思考段落
//   - tool part      -> 工具调用卡（ToolHeader + ToolInput + ToolOutput）
// 按 parts 出现顺序交错成「思考与执行过程」链，移除旧 chainNodes / reasonings 结构。
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import {
  Check as UiCheck,
  ChevronsDown as UiChevronsDown,
  ChevronsUpDown as UiChevronsUpDown,
  CircleCheck as UiCircleCheck,
  CircleX as UiCircleX,
  Copy as UiCopy,
  FileText as UiFileText,
  LoaderCircle as UiLoaderCircle,
  MousePointerClick as UiMousePointerClick,
  Pencil as UiPencil,
  Play as UiPlay,
  Plus as UiPlus,
  Sparkle as UiSparkle,
  Trash2 as UiTrash2,
  X as UiX
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
import type { TokenUsage } from '@/shared/types'
import type { ChatMessageMetadata, ElementPickContext, MessagePageContext } from '@/shared/extension-ipc'
import {
  cancelPick,
  isUserScriptsApiAvailable,
  pickElement
} from '@/lib/element-picker-client'
import {
  clearPickedElement,
  getPickedElement,
  setPickedElement,
  subscribePageContext
} from '@/lib/page-context-store'
import { userscriptClient } from '@/lib/userscripts/ui-client'
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
  /** 各消息本次消耗的 token（按 UIMessage.id 索引），assistant 消息展示在气泡下方 */
  usageByMessageId: Record<string, TokenUsage>
  streaming: boolean
  /** 最近一次生成失败的错误文案（空串 = 无错）；渲染在消息区与输入框之间 */
  errorText?: string
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

/** 随本条消息附上的页面上下文（气泡 chip 渲染源；只认元素拾取，快照已改 AI 工具不再进元数据） */
function messagePageContext(m: UIMessage): MessagePageContext | undefined {
  const ctx = (m.metadata as ChatMessageMetadata | undefined)?.pageContext
  return ctx?.element ? ctx : undefined
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
    title: part.title ?? name,
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

// —— 生成卡片（data-generation data part，docs/userscript-ai-generation.md「生成结果行为」，三出口 = 启用 / 编辑器 / 删除）——
// offscreen 收敛后经 SW 落盘（enabled:false），随流推送 data part、随消息落盘；
// 卡片必须讲清三件事：① 尚未启用 ② 生效范围 ③ 脚本会做什么（bundle 静态扫描）。
interface GenerationCardData {
  uuid: string
  name: string
  enabled: boolean
  matches: string[]
  /** bundle 里扫描到的 DL.* 能力（「会做什么」展示级软审查） */
  capabilities: string[]
  summary: string
  savedAt: number
}

/** 卡片状态覆盖：启用 / 删除后更新本地视图（data part 本身不可变，回读以管理页为准） */
const cardEnabled = reactive(new Set<string>())
const cardHidden = reactive(new Set<string>())
const cardBusy = reactive(new Set<string>())
/** 启用失败的错误（registerError / 命令异常）：按 uuid 记，卡片上直接展示——注册失败绝不能静默 */
const cardErrors = reactive(new Map<string, string>())

function cardsOf(m: UIMessage): GenerationCardData[] {
  return m.parts
    .filter((p) => p.type === 'data-generation')
    .map((p) => (p as { type: 'data-generation'; data: GenerationCardData }).data)
    .filter((c) => c && c.uuid && !cardHidden.has(c.uuid))
}

function cardIsEnabled(card: GenerationCardData): boolean {
  return card.enabled || cardEnabled.has(card.uuid)
}

const CAPABILITY_LABELS: Record<string, string> = {
  info: '自省信息',
  style: '注入样式',
  log: '输出日志',
  store: '读写私有存储',
  fetch: '跨域请求',
  notify: '系统通知',
  download: '下载文件',
  clipboard: '写剪贴板',
  tabs: '开标签页'
}

function capabilityLabel(cap: string): string {
  return CAPABILITY_LABELS[cap] ?? cap
}

async function enableCard(card: GenerationCardData): Promise<void> {
  cardBusy.add(card.uuid)
  cardErrors.delete(card.uuid)
  try {
    const { registerError } = await userscriptClient.toggle(card.uuid, true)
    if (registerError) {
      // 注册失败（典型：扩展详情页没开「允许用户脚本」/ 开发者模式）——错误留在卡片上，
      // 且不把卡片标成已启用（数据已落盘，脚本实际没生效）
      cardErrors.set(card.uuid, registerError)
    } else {
      cardEnabled.add(card.uuid)
    }
  } catch (e) {
    cardErrors.set(card.uuid, e instanceof Error ? e.message : String(e))
  } finally {
    cardBusy.delete(card.uuid)
  }
}

async function removeCard(card: GenerationCardData): Promise<void> {
  cardBusy.add(card.uuid)
  try {
    await userscriptClient.remove(card.uuid)
    cardHidden.add(card.uuid)
  } catch (e) {
    console.error('[duoling] 删除脚本失败：', e)
  } finally {
    cardBusy.delete(card.uuid)
  }
}

/** 进编辑器：工作台 hash 深链直达该脚本的编辑器标签页（#/tool/<uuid>） */
function openWorkbench(uuid: string): void {
  void chrome.tabs.create({
    url: `${chrome.runtime.getURL('workbench.html')}#/tool/${uuid}`,
  })
}

// —— 单条消息复制：方便把消息直接粘给外部 AI 分析 ——
/** 最近一次复制成功的消息 id（1.5s 后还原图标） */
const copiedMessageId = ref('')

async function copyMessage(m: UIMessage): Promise<void> {
  const text = (m.role === 'user' ? userText(m) : finalText(m)).trim()
  if (!text) return
  await navigator.clipboard.writeText(text)
  copiedMessageId.value = m.id
  window.setTimeout(() => {
    if (copiedMessageId.value === m.id) copiedMessageId.value = ''
  }, 1500)
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

// —— 元素拾取（docs/proposals/done/element-picker.md）——
// 产物暂存 page-context-store（模块级，transport 的 collectPageContext 组装进下一条消息），
// 发送成功后 transport 清空，chip 经订阅自动消失。显式点击才采集，页面内容不自动附带。
// 页面快照已改 AI 工具采集（2026-09-17 决策），无用户面入口。
const pickedElement = ref<ElementPickContext | null>(getPickedElement())
let unsubscribeContext: (() => void) | null = null

onMounted(() => {
  unsubscribeContext = subscribePageContext(() => {
    pickedElement.value = getPickedElement()
  })
  window.addEventListener('keydown', onPanelKeydown)
})
onUnmounted(() => {
  unsubscribeContext?.()
  unsubscribeContext = null
  window.removeEventListener('keydown', onPanelKeydown)
})

/** 正在拾取中（按钮转圈 + 防连点） */
const contextBusy = ref<'pick' | null>(null)
/** 拾取失败文案（用户行动可读；区别于聊天错误条，展示在 chip 区） */
const contextError = ref('')

/** chip 上的元素简述：tag#id（文本摘要取前 12 字） */
function elementChipLabel(ctx: ElementPickContext): string {
  const s = ctx.summary
  const text = s.textSample ? ' ' + s.textSample.slice(0, 12) : ''
  return `<${s.tag}${s.id ? '#' + s.id : ''}>${text}`
}

async function onPickElement(): Promise<void> {
  if (contextBusy.value) return
  contextError.value = ''
  if (!isUserScriptsApiAvailable()) {
    // 开关没开：不发起注入，直接给引导文案（探针结论：命名空间不存在时 execute 调用即失败）
    contextError.value = userScriptsUnavailableMessageSafe()
    return
  }
  contextBusy.value = 'pick'
  try {
    const ctx = await pickElement()
    if (ctx) {
      setPickedElement(ctx)
    }
    // null = 用户取消（Esc / 右键）：静默
  } catch (e) {
    contextError.value = e instanceof Error ? e.message : String(e)
  } finally {
    contextBusy.value = null
  }
}

/**
 * 拾取期间侧边栏里的 Esc 取消（cancelPick 补注入指令）。
 * 拾取时键盘焦点在侧边栏，页面 document 收不到 keydown——页面内 Esc 监听只在
 * 页面恰好持有焦点时兜底，主取消路径在这边。监听器全程挂载、回调里按状态放行。
 */
function onPanelKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && contextBusy.value === 'pick') {
    void cancelPick()
  }
}

/** 可用性检测失败时统一给引导文案（client 的 pick 也会抛同文案，此处是免注入的前置短路） */
function userScriptsUnavailableMessageSafe(): string {
  // 引导文案与 client 内部一致；单独 import 会造成循环依赖风险，故内联一份
  return (
    '拾取器不可用：请到 chrome://extensions → 哆灵 → 详情，打开「允许运行用户脚本」开关' +
    '（并确认已开启右上角「开发者模式」），然后重试。'
  )
}
</script>

<template>
  <section class="tool-chat panel">
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
                  <!-- 随消息附上的拾取 chip：落盘元数据还原，重开会话仍在；纯展示（删除 = 删整条消息） -->
                  <div
                    v-if="messagePageContext(m)"
                    class="mb-1 flex flex-wrap justify-end gap-1"
                    data-testid="message-page-context"
                  >
                    <span
                      v-if="messagePageContext(m)!.element"
                      class="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs"
                      :title="messagePageContext(m)!.element!.summary.htmlSample"
                    >
                      <ui-mouse-pointer-click class="size-3 shrink-0 text-muted-foreground" />
                      <span class="truncate">
                        已点选：{{ elementChipLabel(messagePageContext(m)!.element!) }}
                      </span>
                    </span>
                  </div>
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
              <!-- 单条复制：流式占位中的最后一条不渲染（还没有正文可复制） -->
              <button
                v-if="!(m.id === lastMessageId && props.streaming)"
                type="button"
                class="-mt-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
                :title="copiedMessageId === m.id ? '已复制' : '复制这条消息'"
                data-testid="copy-message"
                @click="copyMessage(m)"
              >
                <ui-check v-if="copiedMessageId === m.id" class="size-3.5 text-green-600" />
                <ui-copy v-else class="size-3.5" />
              </button>
              <!-- 生成卡片：offscreen 收敛落盘后随消息推送/回读（尚未启用 · 生效范围 · 会做什么） -->
              <div
                v-for="card in m.role === 'assistant' ? cardsOf(m) : []"
                :key="card.uuid"
                class="w-full min-w-0 rounded-lg border border-border bg-card p-3 text-sm"
                data-testid="generation-card"
              >
                <div class="flex items-center gap-2">
                  <span class="min-w-0 truncate font-medium" :title="card.name">{{ card.name }}</span>
                  <span
                    class="shrink-0 rounded-full px-2 py-0.5 text-xs"
                    :class="cardIsEnabled(card) ? 'bg-green-600/15 text-green-600' : 'bg-amber-500/15 text-amber-600'"
                  >
                    {{ cardIsEnabled(card) ? '已启用' : '尚未启用' }}
                  </span>
                </div>
                <dl class="mt-2 space-y-1 text-xs text-muted-foreground">
                  <div class="flex min-w-0 gap-1.5">
                    <dt class="shrink-0">生效范围</dt>
                    <dd class="min-w-0 break-all" :title="card.matches.join('，')">
                      {{ card.matches.join('，') || '（未指定）' }}
                    </dd>
                  </div>
                  <div class="flex min-w-0 gap-1.5">
                    <dt class="shrink-0">会做什么</dt>
                    <dd class="min-w-0">
                      {{ card.capabilities.length ? card.capabilities.map(capabilityLabel).join(' · ') : '页面 DOM 操作' }}
                    </dd>
                  </div>
                  <div v-if="card.summary" class="flex min-w-0 gap-1.5">
                    <dt class="shrink-0">摘要</dt>
                    <dd class="min-w-0">{{ card.summary }}</dd>
                  </div>
                </dl>
                <div class="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <ui-button
                    v-if="!cardIsEnabled(card)"
                    type="button"
                    size="xs"
                    :disabled="cardBusy.has(card.uuid)"
                    title="启用后脚本将在所有匹配页面自动注入生效"
                    @click="enableCard(card)"
                  >
                    <ui-play class="size-3" />
                    启用并生效
                  </ui-button>
                  <ui-button
                    type="button"
                    variant="outline"
                    size="xs"
                    title="打开工作台直达该脚本的编辑器"
                    @click="openWorkbench(card.uuid)"
                  >
                    <ui-pencil class="size-3" />
                    进编辑器看一眼
                  </ui-button>
                  <ui-button
                    type="button"
                    variant="ghost"
                    size="xs"
                    class="text-destructive hover:text-destructive"
                    :disabled="cardBusy.has(card.uuid)"
                    title="删除该脚本（含 git 历史）"
                    @click="removeCard(card)"
                  >
                    <ui-trash-2 class="size-3" />
                    删除
                  </ui-button>
                </div>
                <p
                  v-if="cardErrors.get(card.uuid)"
                  class="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs leading-relaxed text-destructive"
                  role="alert"
                >
                  启用失败：{{ cardErrors.get(card.uuid) }}
                </p>
              </div>
              <!-- 本次消耗 token：assistant 气泡下方展示（无 usage 时不渲染） -->
              <p
                v-if="m.role === 'assistant' && tokenLabel(usageOf(m.id))"
                class="pl-1 text-xs text-muted-foreground/70"
                title="本次回复消耗的 token"
                data-testid="message-tokens"
              >
                {{ tokenLabel(usageOf(m.id)) }}
              </p>
            </div>
          </template>
        </ui-conversation-content>
        <ui-conversation-scroll-button />
      </ui-conversation>

      <!-- 生成失败警示条：错误文案必须用户可见（曾经全静默，只摘空气泡） -->
      <p
        v-if="props.errorText"
        class="mx-3 mb-1 shrink-0 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs leading-relaxed text-destructive"
        role="alert"
        data-testid="chat-error"
      >
        {{ props.errorText }}
      </p>

      <div class="border-t p-3">
        <!-- 拾取 chip：随下一条消息发出的暂存上下文，× 可清除；发送成功后自动消失 -->
        <div
          v-if="pickedElement || contextError"
          class="mb-2 flex flex-wrap items-center gap-1.5"
          data-testid="page-context-chips"
        >
          <span
            v-if="pickedElement"
            class="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs"
          >
            <ui-mouse-pointer-click class="size-3 shrink-0 text-muted-foreground" />
            <span class="truncate" :title="pickedElement.summary.htmlSample">
              已点选：{{ elementChipLabel(pickedElement) }}
            </span>
            <button
              type="button"
              class="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="清除已点选元素"
              data-testid="clear-picked-element"
              @click="clearPickedElement()"
            >
              <ui-x class="size-3" />
            </button>
          </span>
        </div>
        <p
          v-if="contextError"
          class="mb-2 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs leading-relaxed text-destructive"
          role="alert"
          data-testid="context-error"
        >
          {{ contextError }}
        </p>
        <ui-prompt-input @submit="onPromptSubmit">
          <ui-prompt-input-textarea
            placeholder="输入消息…"
            :disabled="props.streaming"
          />
          <ui-prompt-input-footer>
            <!-- 工具区：页面拾取 + 模型选择（页面快照已改 AI 工具采集，无用户面入口） -->
            <ui-prompt-input-tools>
              <ui-button
                type="button"
                variant="outline"
                size="xs"
                :disabled="contextBusy !== null"
                title="在当前页面点选一个元素，随下一条消息发给 AI"
                aria-label="点选元素"
                data-testid="pick-element-button"
                @click="onPickElement"
              >
                <ui-loader-circle v-if="contextBusy === 'pick'" class="size-3 animate-spin" />
                <ui-mouse-pointer-click v-else class="size-3" />
                点选元素
              </ui-button>
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
