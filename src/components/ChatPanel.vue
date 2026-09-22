<script setup lang="ts">
// 当前会话聊天区：消息气泡 + 思考/工具过程折叠 + 输入区 + 模型选择。
// 发送 / 停止由父组件执行；模型选择为纯本地面板逻辑，自含于此。
//
// 消息模型为 UIMessage（parts），渲染按
//   - text part      -> 消息气泡正文（MessageResponse）
//   - reasoning part -> 思考与执行过程中的思考段落
//   - tool part      -> 工具调用卡（ToolHeader + ToolInput + ToolOutput）
// 按 parts 出现顺序交错成「思考与执行过程」链。
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useDataSync } from '@/composables/use-data-sync'
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
  Square as UiSquare,
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
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger
} from '@/components/ui/tooltip'
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
import type { DynamicToolUIPart, TextUIPart, ToolUIPart, UIMessage } from 'ai'
// 这几个 part 判定 helper 走本地实现：静态 import 'ai' 会把整块 ~360KB 的核心
// （含 gateway / zod）钉进对话界面首屏静态图。详见该文件头部说明。
import { getToolName, isReasoningUIPart, isTextUIPart, isToolUIPart, textOfMessage } from '@/lib/ui-message-parts'

const props = defineProps<{
  messages: UIMessage[]
  /** 各消息本次消耗的 token（按 UIMessage.id 索引），assistant 消息展示在气泡下方 */
  usageByMessageId: Record<string, TokenUsage>
  streaming: boolean
  /** 最近一次生成失败的错误文案（空串 = 无错）；渲染在消息区与输入框之间 */
  errorText?: string
  /** 只读回放：不渲染输入区（含拾取与模型切换）—— 工作台「会话历史」看历史用。
   *  消息区、思考链、工具卡、复制、生成卡片都照常，只是不能再发消息。 */
  readonly?: boolean
}>()
const emit = defineEmits<{
  send: [text: string]
  stop: []
  openSettings: []
  /** 需要开权限（拾取器不可用 / 启用脚本失败）：请宿主打开工作台引导标签页 */
  openGuide: []
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
  () => profiles.value.find((p) => p.id === activeModelId.value)?.name ?? '未选中模型'
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

// 模型配置在别处变更（工作台模型管理 / 其它窗口的设置页）时自动重拉列表，
// 否则对话界面下拉会停留在挂载时的旧数据（useDataSync 自带在途合并，挂载即订阅、卸载自动退订）
useDataSync('model', () => window.api.model.list().then(refreshModelStatus))

// —— 消息渲染：UIMessage parts -> 气泡正文 / 思考与执行过程 ——

/** 用户消息正文：text parts 顺序拼接（口径与落盘侧共用 lib/ui-message-parts 的 textOfMessage）。
 * 非文本 part（未来可能的附件）目前不在这里渲染——正文口径要改就改那个共享 helper。 */
function userText(m: UIMessage): string {
  return textOfMessage(m)
}

/** 随本条消息附上的页面上下文（气泡 chip 渲染源；只认元素拾取，快照不进元数据） */
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

// —— 生成卡片（data-generation data part，三出口 = 启用 / 编辑器 / 删除）——
// offscreen 收敛后经 SW 落盘（enabled:false），随流推送 data part、随消息落盘；
// 卡片必须讲清三件事：① 尚未启用 ② 生效范围 ③ 脚本会做什么（bundle 静态扫描）。
interface GenerationCardData {
  uuid: string
  name: string
  enabled: boolean
  matches: string[]
  /** 源码里扫描到的 GM 能力（「会做什么」展示级软审查，见 chat-host.scanCapabilities） */
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
/** 上面那批错误里属「没开权限」的（registerError）：附带引导入口；命令异常则不给（原因不在这） */
const cardErrorNeedsGuide = reactive(new Set<string>())

/** 这条回复是不是被中止的（offscreen 中止落盘时附的 data-interrupted 标记，见 chat-host） */
function isInterrupted(m: UIMessage): boolean {
  return m.parts.some((p) => p.type === 'data-interrupted')
}

function cardsOf(m: UIMessage): GenerationCardData[] {
  return m.parts
    .filter((p) => p.type === 'data-generation')
    .map((p) => (p as { type: 'data-generation'; data: GenerationCardData }).data)
    .filter((c) => c && c.uuid && !cardHidden.has(c.uuid))
}

function cardIsEnabled(card: GenerationCardData): boolean {
  return card.enabled || cardEnabled.has(card.uuid)
}

/** 能力 id（chat-host.scanCapabilities 的产出）→ 卡片上的中文短语。新增能力记得两处同改 */
const CAPABILITY_LABELS: Record<string, string> = {
  info: '自省信息',
  style: '注入样式',
  log: '输出日志',
  store: '读写私有存储',
  fetch: '跨域请求',
  notify: '系统通知',
  download: '下载文件',
  clipboard: '写剪贴板',
  tabs: '标签页操作',
  menu: '右键菜单',
  cookie: 'cookie 读写',
  page: '页面事件监听',
}

function capabilityLabel(cap: string): string {
  return CAPABILITY_LABELS[cap] ?? cap
}

async function enableCard(card: GenerationCardData): Promise<void> {
  cardBusy.add(card.uuid)
  cardErrors.delete(card.uuid)
  cardErrorNeedsGuide.delete(card.uuid)
  try {
    const { registerError } = await userscriptClient.toggle(card.uuid, true)
    if (registerError) {
      // 注册失败（典型：扩展详情页没开「允许用户脚本」/ 开发者模式）——错误留在卡片上，
      // 且不把卡片标成已启用（数据已落盘，脚本实际没生效）
      cardErrors.set(card.uuid, registerError)
      cardErrorNeedsGuide.add(card.uuid)
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

// —— 接口录制同意卡（data-net-capture data part，两态 = 未开启 / 录制中）——
// AI 判断写脚本需要目标站点的真实接口时出这张卡（net_capture_enable 工具，由 offscreen 推 part）。
// 卡片是用户唯一的操作入口，也是隐私边界的落点：录什么是写死的，开关只在当前站点生效。
// 开启后引导点**浏览器的刷新按钮**——录制只能抓开启之后的请求，钩子挂在文档开头。
interface NetCaptureCardData {
  host: string
}

/** 已开启录制的站点（SW 为权威；这里是渲染用的本地视图，点击后即时更新） */
const captureHosts = reactive(new Set<string>())
const captureBusy = reactive(new Set<string>())
const captureErrors = reactive(new Map<string, string>())

/** 拉一次授权态：历史卡片的状态以 SW 为准，不能只信卡片落盘那一刻的快照 */
async function loadCaptureHosts(): Promise<void> {
  try {
    const { hosts } = await userscriptClient.netCaptureState()
    captureHosts.clear()
    for (const h of hosts) captureHosts.add(h)
  } catch {
    // 读不到就按未开启渲染（用户点开启时会看到真实错误）
  }
}

onMounted(() => {
  void loadCaptureHosts()
})

/** 该消息里的同意卡（按 host 去重：同一站点被请求两次同意也只渲染一张） */
function captureCardsOf(m: UIMessage): NetCaptureCardData[] {
  const seen = new Set<string>()
  const out: NetCaptureCardData[] = []
  for (const p of m.parts) {
    if (p.type !== 'data-net-capture') continue
    const host = (p as { data?: NetCaptureCardData }).data?.host
    if (!host || seen.has(host)) continue
    seen.add(host)
    out.push({ host })
  }
  return out
}

async function enableCapture(host: string): Promise<void> {
  captureBusy.add(host)
  captureErrors.delete(host)
  try {
    await userscriptClient.netCaptureEnable(host)
    captureHosts.add(host)
  } catch (e) {
    captureErrors.set(host, e instanceof Error ? e.message : String(e))
  } finally {
    captureBusy.delete(host)
  }
}

async function disableCapture(host: string): Promise<void> {
  captureBusy.add(host)
  captureErrors.delete(host)
  try {
    await userscriptClient.netCaptureDisable(host)
    captureHosts.delete(host)
  } catch (e) {
    captureErrors.set(host, e instanceof Error ? e.message : String(e))
  } finally {
    captureBusy.delete(host)
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

// —— 元素拾取 ——
// 产物暂存 page-context-store（模块级，transport 的 collectPageContext 组装进下一条消息），
// 发送成功后 transport 清空，chip 经订阅自动消失。显式点击才采集，页面内容不自动附带。
// 页面快照走 AI 工具采集（见 element-picker-client.ts），无用户面入口。
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
/** 该错误是否属「去工作台引导页开权限」类（决定错误条里是否给引导入口） */
const contextErrorNeedsGuide = ref(false)

/** chip 上的元素简述：tag#id（文本摘要取前 12 字） */
function elementChipLabel(ctx: ElementPickContext): string {
  const s = ctx.summary
  const text = s.textSample ? ' ' + s.textSample.slice(0, 12) : ''
  return `<${s.tag}${s.id ? '#' + s.id : ''}>${text}`
}

async function onPickElement(): Promise<void> {
  if (contextBusy.value) return
  contextError.value = ''
  contextErrorNeedsGuide.value = false
  if (!isUserScriptsApiAvailable()) {
    // 开关没开：不发起注入，直接给引导文案（探针结论：命名空间不存在时 execute 调用即失败）
    contextError.value = userScriptsUnavailableMessageSafe()
    contextErrorNeedsGuide.value = true
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
 * 拾取期间对话界面里的 Esc 取消（cancelPick 补注入指令）。
 * 拾取时键盘焦点在对话界面，页面 document 收不到 keydown——页面内 Esc 监听只在
 * 页面恰好持有焦点时兜底，主取消路径在这边。监听器全程挂载、回调里按状态放行。
 */
function onPanelKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && contextBusy.value === 'pick') {
    void cancelPick()
  }
}

/** 可用性检测失败时统一给引导文案（client 的 pick 也会抛同文案，此处是免注入的前置短路） */
function userScriptsUnavailableMessageSafe(): string {
  // 引导文案与 client 内部一致；单独 import 会造成循环依赖风险，故内联一份。
  // 具体步骤（按浏览器/版本分支）与「打开扩展管理页」按钮统一在工作台「引导」标签页，此处只指路
  return '拾取器不可用：需要先开启「允许运行用户脚本」权限，开启后重试。'
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
              <ui-tooltip-provider>
                <ui-tooltip>
                  <ui-tooltip-trigger as-child>
                    <button
                      v-if="!(m.id === lastMessageId && props.streaming)"
                      type="button"
                      class="-mt-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
                      aria-label="复制这条消息"
                      data-testid="copy-message"
                      @click="copyMessage(m)"
                    >
                      <ui-check v-if="copiedMessageId === m.id" class="size-3.5 text-green-600" />
                      <ui-copy v-else class="size-3.5" />
                    </button>
                  </ui-tooltip-trigger>
                  <ui-tooltip-content>
                    {{ copiedMessageId === m.id ? '已复制' : '复制这条消息' }}
                  </ui-tooltip-content>
                </ui-tooltip>
              </ui-tooltip-provider>
              <!-- 接口录制同意卡：AI 要目标站点的真实接口时出（data-net-capture part，随消息落盘） -->
              <div
                v-for="card in m.role === 'assistant' ? captureCardsOf(m) : []"
                :key="`net-${card.host}`"
                class="w-full min-w-0 rounded-lg border border-border bg-card p-3 text-sm"
                data-testid="net-capture-card"
              >
                <div class="flex items-center gap-2">
                  <span class="min-w-0 truncate font-medium" :title="card.host">{{ card.host }}</span>
                  <span
                    class="shrink-0 rounded-full px-2 py-0.5 text-xs"
                    :class="
                      captureHosts.has(card.host)
                        ? 'bg-green-600/15 text-green-600'
                        : 'bg-amber-500/15 text-amber-600'
                    "
                  >
                    {{ captureHosts.has(card.host) ? '录制中' : '未开启' }}
                  </span>
                </div>
                <dl class="mt-2 space-y-1 text-xs text-muted-foreground">
                  <div class="flex min-w-0 gap-1.5">
                    <dt class="shrink-0">记录内容</dt>
                    <dd class="min-w-0 break-all">页面发出的请求：地址 · 方法 · 请求体 · 响应结构</dd>
                  </div>
                  <div class="flex min-w-0 gap-1.5">
                    <dt class="shrink-0">存放位置</dt>
                    <dd class="min-w-0 break-all">仅本机，只对 {{ card.host }} 生效</dd>
                  </div>
                  <div class="flex min-w-0 gap-1.5">
                    <dt class="shrink-0">保留条数</dt>
                    <dd class="min-w-0">最近 200 条</dd>
                  </div>
                </dl>
                <div class="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <ui-button
                    v-if="!captureHosts.has(card.host)"
                    type="button"
                    size="xs"
                    :disabled="captureBusy.has(card.host)"
                    title="只记录当前站点，数据留在本机"
                    @click="enableCapture(card.host)"
                  >
                    <ui-play class="size-3" />
                    开启录制
                  </ui-button>
                  <ui-button
                    v-else
                    type="button"
                    variant="outline"
                    size="xs"
                    :disabled="captureBusy.has(card.host)"
                    title="关闭后已录到的内容保留"
                    @click="disableCapture(card.host)"
                  >
                    <ui-square class="size-3" />
                    关闭录制
                  </ui-button>
                </div>
                <p
                  v-if="captureHosts.has(card.host)"
                  class="mt-2 text-xs leading-relaxed text-muted-foreground"
                >
                  用浏览器的刷新按钮重新加载页面，从首屏请求开始记录。
                </p>
                <div
                  v-if="captureErrors.get(card.host)"
                  class="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs leading-relaxed text-destructive"
                  role="alert"
                >
                  {{ captureErrors.get(card.host) }}
                </div>
              </div>
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
                    title="删除该脚本（含历史版本）"
                    @click="removeCard(card)"
                  >
                    <ui-trash-2 class="size-3" />
                    删除
                  </ui-button>
                </div>
                <div
                  v-if="cardErrors.get(card.uuid)"
                  class="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs leading-relaxed text-destructive"
                  role="alert"
                >
                  <p>启用失败：{{ cardErrors.get(card.uuid) }}</p>
                  <!-- 注册失败多半是没开权限：分步说明在工作台「引导」标签页 -->
                  <ui-button
                    v-if="cardErrorNeedsGuide.has(card.uuid)"
                    type="button"
                    variant="outline"
                    size="xs"
                    class="mt-1.5"
                    data-testid="card-error-open-guide"
                    @click="emit('openGuide')"
                  >
                    查看开启引导
                  </ui-button>
                </div>
              </div>
              <!-- 被中止的回复：内容只到停下的地方（offscreen 中止落盘时附的 data-interrupted 标记）。
                   标出来，免得事后翻会话历史把半截当成完整回复。 -->
              <p
                v-if="m.role === 'assistant' && isInterrupted(m)"
                class="pl-1 text-xs text-muted-foreground/70"
                data-testid="message-interrupted"
              >
                已中断
              </p>
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

      <!-- 输入区：只读回放（工作台「会话历史」）不渲染 —— 看历史不需要输入框，
           留着反而让人以为这个 tab 能发消息 -->
      <div v-if="!props.readonly" class="border-t p-3">
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
        <div
          v-if="contextError"
          class="mb-2 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs leading-relaxed text-destructive"
          role="alert"
          data-testid="context-error"
        >
          <p>{{ contextError }}</p>
          <!-- 开权限类引导：完整步骤与「打开扩展管理页」按钮都在工作台「引导」标签页，此处只给入口 -->
          <ui-button
            v-if="contextErrorNeedsGuide"
            type="button"
            variant="outline"
            size="xs"
            class="mt-1.5"
            data-testid="context-error-open-guide"
            @click="emit('openGuide')"
          >
            查看开启引导
          </ui-button>
        </div>
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
                <!-- 无可用模型时：列表为空，仅显示空态提示 -->
                <p v-else class="px-2 py-1.5 text-xs text-muted-foreground">模型列表为空</p>
                <!-- 底部「去添加模型」：跳转到设置页自行添加 -->
                <div class="mt-1 border-t border-muted pt-1">
                  <button
                    type="button"
                    class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
                    @click="goToSettings"
                  >
                    <ui-plus class="size-3.5 shrink-0" />
                    去添加模型
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
