<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  Popover as UiPopover,
  PopoverContent as UiPopoverContent,
  PopoverTrigger as UiPopoverTrigger
} from '@/components/ui/popover'
import {
  ResizableHandle as UiResizableHandle,
  ResizablePanel as UiResizablePanel,
  ResizablePanelGroup as UiResizablePanelGroup
} from '@/components/ui/resizable'
import { parseGeneratedChanges, type GeneratedChangeList } from '@/lib/tool-generator'
import ToolIcon from '@/components/tool-icon.vue'
import ToolFrame from '@/components/tool-frame.vue'
import {
  Check as UiCheck,
  ChevronRight as UiChevronRight,
  ChevronsUpDown as UiChevronsUpDown,
  GitBranch as UiGitBranch,
  ListTodo as UiListTodo,
  Plus as UiPlus,
  Trash2 as UiTrash2
} from '@lucide/vue'

// 一个工具标签页的标识：唯一 ID（决定 tool:// 源与工具文件夹名）+ 展示名
export interface ToolPageMeta {
  id: string
  title: string
  /** 工具图标（单个字符），可选；用于工具详情头部展示 */
  icon?: string
}

const props = defineProps<{ tool: ToolPageMeta }>()

// 工具详情 <webview> 引用：改动落盘后经其 reload() 重载工具页
const frameRef = ref<InstanceType<typeof ToolFrame> | null>(null)

// 「当前会话」按工具内会话隔离：每个 session 有独立消息列表，切换会话时回显。
// 会话与消息按工具 id 分桶持久化到 localStorage，切换/重启后不丢。
// 「当前会话」已接入生成器：消息发送 → LLM 产出变更清单 → 写入当前工具 index.html + meta.json
interface ToolSession {
  id: string
  status: 'doing' | 'done' | 'rollback'
  title: string
  meta: string
}

interface ToolChatMessage {
  id: string
  role: 'ai' | 'user'
  content: string
}

const emit = defineEmits<{
  renamed: [id: string, title: string]
  openSettings: []
  openHistory: [tool: ToolPageMeta]
}>()

// 会话列表与其消息桶（以 sessionId 为键）
const sessions = ref<ToolSession[]>([])
const activeSessionId = ref('')
const messagesBySession = ref<Record<string, ToolChatMessage[]>>({})
// messages 是「当前激活会话」消息的视图：读跟随 activeSessionId，写回对应桶
const messages = computed<ToolChatMessage[]>({
  get: () => messagesBySession.value[activeSessionId.value] ?? [],
  set: (v) => {
    messagesBySession.value[activeSessionId.value] = v
  }
})
const input = ref('')
const streaming = ref(false)
const draft = ref<ToolChatMessage | null>(null)

// 自动审批：AI 产出变更清单后直接落盘（卡片仅作留痕展示，不再触发手动确认）
interface PendingChange {
  messageId: string
  changes: GeneratedChangeList
  status: 'pending' | 'applied' | 'discarded'
  error?: string
}
// 待审批的变更卡片按「会话 + 消息」记录：同一会话内每条 AI 变更消息都保留独立卡片，
// 已应用 / 已放弃的状态随卡片持久化，切换会话时回显原状态。
const pendingBySession = ref<Record<string, Record<string, PendingChange>>>({})
// 当前激活会话的卡片映射（messageId -> PendingChange），切换会话时随 activeSessionId 回显
const pendingMap = computed<Record<string, PendingChange>>(
  () => pendingBySession.value[activeSessionId.value] ?? {}
)

/** 取某条 AI 消息挂载的变更卡片（可能不存在，如自动模式或无变更） */
function pendingOf(messageId: string): PendingChange | undefined {
  return pendingMap.value[messageId]
}

// 兼容旧版本单例存储（Record<sessionId, PendingChange | null>）迁移为按消息分桶
function normalizePendingStore(
  store: unknown
): Record<string, Record<string, PendingChange>> {
  const out: Record<string, Record<string, PendingChange>> = {}
  if (!store || typeof store !== 'object') return out
  for (const [sid, val] of Object.entries(store as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') {
      out[sid] = {}
      continue
    }
    const v = val as Record<string, unknown>
    // 旧结构：单个卡片（含 messageId）或 null；新结构：messageId -> 卡片的哈希
    if (typeof v.messageId === 'string') {
      const pc = val as unknown as PendingChange
      out[sid] = typeof pc.messageId === 'string' ? { [pc.messageId]: pc } : {}
    } else {
      const map: Record<string, PendingChange> = {}
      for (const [mid, card] of Object.entries(v)) {
        if (card && typeof card === 'object' && (card as PendingChange).messageId) {
          map[mid] = card as PendingChange
        }
      }
      out[sid] = map
    }
  }
  return out
}

onMounted(async () => {
  window.api.generator.onEvent(onGeneratorEvent)
  void window.api.model.list().then(refreshModelStatus)
  // 恢复本工具的会话历史（多会话：切换回显 + 本地持久化）
  const saved = loadSessions()
  if (saved) {
    sessions.value = saved.sessions ?? []
    messagesBySession.value = saved.messagesBySession ?? {}
    pendingBySession.value = normalizePendingStore(saved.pendingBySession)
    activeSessionId.value = saved.activeSessionId ?? ''
  }
  // 无可用会话（首次进入或数据损坏）时自动新建，保证当前会话始终存在
  if (!activeSessionId.value || !sessions.value.some((s) => s.id === activeSessionId.value)) {
    newSession()
  }
})

onUnmounted(() => {
  window.api.generator.offEvent()
})

// —— 思考过程可视化：把 <think>...</think> 拆为「思考内容」与「答案」两部分 ——
// 对称处理 think 标签：成对块进「思考内容」；只有 <think> 未闭合时也视为思考（吞到末尾）；
// 孤立的 </think> 等散落标签则从「答案」中清掉，避免正文露出标签。
function splitContent(content: string): { think: string; answer: string } {
  const thinkBlocks = content.match(/<think>[\s\S]*?(?:<\/think>|$)/gi) ?? []
  const think = thinkBlocks
    .map((t) => t.replace(/<\/?think>/gi, '').trim())
    .filter(Boolean)
    .join('\n\n')
  const answer = content
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim()
  return { think, answer }
}

const thinkOf = (m: ToolChatMessage): string => splitContent(m.content).think

/** 流式草稿中正文是否仍是「生成工具的契约 JSON」（以 ```json 或 { 开头）。
 * 是则用「正在思考…」遮挡，避免正文先把 JSON 逐字输出、完成后瞬间跳变 summary 的割裂感。 */
function isContractAnswer(text: string): boolean {
  const t = text.trim()
  return t.startsWith('```json') || t.startsWith('{')
}

/** 打字机：记录各消息正文已显示的字符数（模拟流式逐字输出） */
const typing = ref<Record<string, number>>({})

/** 消息正文：已完成的非契约正文用打字机逐字显示；流式契约 JSON 用「正在思考…」遮挡 */
function answerOf(m: ToolChatMessage): string {
  const raw = splitContent(m.content).answer
  if (isContractAnswer(raw)) return '正在思考…'
  const n = typing.value[m.id]
  return n != null ? raw.slice(0, n) : raw
}

/** 启动「假流式」：把正文按帧逐字追加直到完整。契约 JSON 不参与，避免解析失败时泄露原文。 */
function runTyping(messageId: string, full: string): void {
  if (!full || isContractAnswer(full)) return
  let shown = 0
  typing.value[messageId] = shown
  const step = (): void => {
    shown += 1
    typing.value[messageId] = shown
    if (shown >= full.length) {
      delete typing.value[messageId]
      return
    }
    setTimeout(step, 24)
  }
  setTimeout(step, 24)
}

// 折叠式思考过程：记录已展开的消息 id（默认折叠）
const expandedThink = ref<Set<string>>(new Set())
function toggleThink(id: string): void {
  const next = new Set(expandedThink.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedThink.value = next
}

// —— 对话模型选择：与 chat-panel 一致，仅切换后续发送所用的模型 ——
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

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// 截断长文本，用于在变更卡片里展示 patch 的查找串摘要
function truncate(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max)}` : text
}

// —— 会话持久化：按工具 id 分桶存 localStorage，切换/刷新/重启后回显 ——
function storageKey(): string {
  return `duo-ling:tool:sessions:${props.tool.id}`
}

interface SessionStore {
  sessions: ToolSession[]
  messagesBySession: Record<string, ToolChatMessage[]>
  pendingBySession: Record<string, Record<string, PendingChange>>
  activeSessionId: string
}

function loadSessions(): SessionStore | null {
  try {
    const raw = localStorage.getItem(storageKey())
    return raw ? (JSON.parse(raw) as SessionStore) : null
  } catch {
    return null
  }
}

function saveSessions(): void {
  try {
    localStorage.setItem(
      storageKey(),
      JSON.stringify({
        sessions: sessions.value,
        messagesBySession: messagesBySession.value,
        pendingBySession: pendingBySession.value,
        activeSessionId: activeSessionId.value
      } satisfies SessionStore)
    )
  } catch (error) {
    console.error('保存会话失败：', error)
  }
}

// 切换到某会话：更新活动 id 即回显对应消息与待审批卡片；仅清掉流式草稿（草稿为临时态）
function activateSession(id: string): void {
  if (id === activeSessionId.value) return
  activeSessionId.value = id
  draft.value = null
  saveSessions()
}

// 根据首条用户输入生成会话标题摘要，便于在「会话历史」中辨认
function summarizeTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > 12 ? `${t.slice(0, 12)}…` : t
}

function newSession(): void {
  const id = `s-${Date.now()}`
  const session: ToolSession = {
    id,
    status: 'doing',
    title: '新会话',
    meta: formatDate(new Date())
  }
  sessions.value.push(session)
  messagesBySession.value[id] = []
  activeSessionId.value = id
  pendingBySession.value[id] = {}
  saveSessions()
}

// —— 删除会话：单个 / 全部，删除前用「跟随点击位置的确认浮层」确认 ——
// 单一浮层实例：点击删除按钮时记录点击坐标与删除目标类型，浮层在点击处弹出。
// 避免为每个按钮各自挂 Popover、在 v-for 中产生多个浮层实例导致定位/内容串扰（点单个却弹出「全部」文案）。
const deleteConfirm = ref<
  { type: 'session' | 'all'; id?: string; title?: string; x: number; y: number } | null
>(null)

function openSessionDelete(
  s: { id: string; title: string },
  e: MouseEvent
): void {
  e.stopPropagation()
  deleteConfirm.value = { type: 'session', id: s.id, title: s.title, x: e.clientX, y: e.clientY }
}

function openDeleteAll(e: MouseEvent): void {
  deleteConfirm.value = { type: 'all', x: e.clientX, y: e.clientY }
}

function cancelDelete(): void {
  deleteConfirm.value = null
}

function confirmDelete(): void {
  const t = deleteConfirm.value
  if (!t) return
  if (t.type === 'session' && t.id) deleteSession(t.id)
  else deleteAllSessions()
  deleteConfirm.value = null
}

// 确认浮层定位：跟随点击坐标，并钳制在视口内避免溢出
const confirmStyle = computed(() => {
  const t = deleteConfirm.value
  if (!t) return {}
  const x = Math.min(t.x + 8, window.innerWidth - 240)
  const y = Math.min(t.y + 8, window.innerHeight - 140)
  return { left: x + 'px', top: y + 'px' }
})

function deleteSession(id: string): void {
  sessions.value = sessions.value.filter((s) => s.id !== id)
  delete messagesBySession.value[id]
  delete pendingBySession.value[id]
  if (activeSessionId.value === id) {
    activeSessionId.value = ''
    // 仍有余下会话则激活第一个；否则新建空会话保证当前会话始终存在
    if (sessions.value.length) {
      activeSessionId.value = sessions.value[0].id
    } else {
      newSession()
      return
    }
  }
  saveSessions()
}

function deleteAllSessions(): void {
  sessions.value = []
  messagesBySession.value = {}
  pendingBySession.value = {}
  activeSessionId.value = ''
  draft.value = null
  newSession()
}

// 生成器流式 token：把增量累积到待生成的草稿消息（done/aborted/error 由 send 收尾，避免重复处理）
function onGeneratorEvent(
  payload:
    | { type: 'token'; token: string }
    | { type: 'done'; content: string }
    | { type: 'aborted'; content: string }
    | { type: 'error'; error: string }
): void {
  if (payload.type === 'token' && draft.value) {
    draft.value.content += payload.token
  }
}

async function send(): Promise<void> {
  const text = input.value.trim()
  if (!text || streaming.value) return
  input.value = ''

  messages.value.push({ id: `u-${Date.now()}`, role: 'user', content: text })
  // 首次提问用用户输入生成会话标题摘要，方便「会话历史」辨认
  const curSession = sessions.value.find((s) => s.id === activeSessionId.value)
  if (curSession && (curSession.title === '新会话' || curSession.title === '未命名会话')) {
    curSession.title = summarizeTitle(text)
  }
  saveSessions()
  // 生成器要求最后一条为用户消息；把 ai 映射为 assistant
  const history = messages.value.map((m) => ({
    role: (m.role === 'ai' ? 'assistant' : 'user') as 'user' | 'assistant',
    content: m.content
  }))

  const draftMsg: ToolChatMessage = { id: `a-${Date.now()}`, role: 'ai', content: '' }
  messages.value.push(draftMsg)
  draft.value = draftMsg
  streaming.value = true

  try {
    const res = await window.api.generator.send(history)
    if (res.content) {
      draftMsg.content = res.content
      const parsed = parseGeneratedChanges(res.content)
      // changes 为 null：可视作 LLM 在澄清追问 / 能力缺失说明，保留原文作为普通回复
      if (parsed.changes) {
        // 有实际改动：正文不再直出契约 JSON，改用 summary 作为人类可读回复
        // （保留思考过程；卡片另展示 summary + 动作详情，避免正文裸露 JSON 字符串）。
        const summary = parsed.changes.summary?.trim()
          ? parsed.changes.summary
          : '已生成对当前工具的改动并应用'
        const { think } = splitContent(draftMsg.content)
        draftMsg.content = think ? `<think>${think}</think>\n\n${summary}` : summary
        // 自动落盘：AI 改完直接应用；先把变更清单记入卡片作留痕，失败错误由 applyChanges 回填到卡片
        pendingMap.value[draftMsg.id] = {
          messageId: draftMsg.id,
          changes: parsed.changes,
          status: 'pending'
        }
        saveSessions()
        await applyChanges(draftMsg.id, parsed.changes)
      } else if (parsed.summary) {
        // LLM 输出的是「无实际动作」的契约 JSON（多为澄清追问）：
        // 把直出的原始 JSON 替换为人性化 summary；同时保留思考过程，
        // 避免用 summary 整体覆盖 content 导致完成后思考过程消失。
        const { think } = splitContent(draftMsg.content)
        draftMsg.content = think ? `<think>${think}</think>\n\n${parsed.summary}` : parsed.summary
      }
      // 「假流式」：正文解析完成后逐字显示（契约 JSON 在 runTyping 内被排除）
      runTyping(draftMsg.id, splitContent(draftMsg.content).answer)
    } else if (res.error) {
      messages.value = messages.value.filter((m) => m.id !== draftMsg.id)
    }
  } catch (error) {
    messages.value = messages.value.filter((m) => m.id !== draftMsg.id)
  } finally {
    draft.value = null
    streaming.value = false
    saveSessions()
  }
}

// 应用变更清单：调用主进程落盘，成功则同步标签名并刷新工具页
async function applyChanges(messageId: string, changes: GeneratedChangeList): Promise<void> {
  // 按消息定位留痕卡片：存在则把结果（已应用/错误）回填到卡片，否则回填到消息正文
  const current = pendingMap.value[messageId]
  let updated: Awaited<ReturnType<typeof window.api.tool.update>>
  try {
    // changes 可能来自响应式 ref（pendingOf().changes），实为 Vue 的 reactive Proxy，
    // 直接经 contextBridge 传给主进程会触发 structured clone 报「An object could not be cloned」。
    // 先做一次 JSON 深拷贝得到纯数据对象，再跨进程传递。
    const payload = JSON.parse(JSON.stringify(changes)) as GeneratedChangeList
    updated = await window.api.tool.update(props.tool.id, payload)
  } catch (error) {
    // Promise 拒绝也要回显，避免 void 调用吞掉异常导致「点击无反应」
    const err = error instanceof Error ? error.message : String(error)
    console.error('[tool-page] applyChanges 调用失败：', error)
    if (current && current.messageId === messageId) {
      current.error = err
      return
    }
    const msg = messages.value.find((m) => m.id === messageId)
    if (msg) msg.content += `\n\n[写入工具失败] ${err}`
    return
  }
  if (updated.ok) {
    if (current && current.messageId === messageId) {
      current.status = 'applied'
      saveSessions()
    }
    if (updated.title) emit('renamed', props.tool.id, updated.title)
    frameRef.value?.reload()
  } else {
    const err = updated.error ?? '未知错误'
    // 在留痕卡片里展示错误，并保留「应用/放弃」按钮供用户重试或放弃
    if (current && current.messageId === messageId) {
      current.error = err
      saveSessions()
      return
    }
    // 无卡片可挂载时，把错误回填到消息正文
    const msg = messages.value.find((m) => m.id === messageId)
    if (msg) msg.content += `\n\n[写入工具失败] ${err}`
  }
}

function applyPending(messageId: string): void {
  const current = pendingMap.value[messageId]
  if (current && current.messageId === messageId && current.status === 'pending') {
    void applyChanges(messageId, current.changes)
  }
}

function discardPending(messageId: string): void {
  const current = pendingMap.value[messageId]
  if (current && current.messageId === messageId && current.status === 'pending') {
    current.status = 'discarded'
    saveSessions()
  }
}

async function stopGeneration(): Promise<void> {
  await window.api.generator.abort()
}
</script>

<template>
  <ui-resizable-panel-group direction="horizontal" class="tool-page h-full w-full">
    <!-- 会话历史 -->
    <ui-resizable-panel :default-size="20" :min-size="15" :max-size="40" class="min-w-0">
      <aside class="tool-sess panel">
        <header class="panel-header flex items-center justify-between gap-2">
          <h2 class="panel-title flex items-center gap-2">
            <ui-list-todo class="size-4" />
            会话历史
          </h2>
        <div class="flex items-center gap-1">
          <ui-button
            variant="ghost"
            size="icon"
            class="no-drag size-7"
            aria-label="删除全部会话"
            title="删除全部会话"
            :disabled="!sessions.length"
            @click="openDeleteAll"
          >
            <ui-trash2 class="size-4" />
          </ui-button>
          <ui-button
            variant="ghost"
            size="icon"
            class="no-drag size-7"
            aria-label="新建会话"
            title="新建会话"
            @click="newSession"
          >
            <ui-plus class="size-4" />
          </ui-button>
        </div>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto scroll-gap">
        <ul v-if="sessions.length" class="divide-y">
          <li
            v-for="s in sessions"
            :key="s.id"
            class="group cursor-pointer px-4 py-2.5 transition-colors hover:bg-accent"
            :class="{ 'bg-accent': s.id === activeSessionId }"
            @click="activateSession(s.id)"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="truncate text-sm">{{ s.title }}</p>
                <p class="text-muted-foreground text-xs">{{ s.meta }}</p>
              </div>
              <ui-button
                variant="ghost"
                size="icon"
                class="size-6 shrink-0 text-muted-foreground transition-colors hover:text-destructive no-drag"
                aria-label="删除该会话"
                title="删除该会话"
                @click="openSessionDelete(s, $event)"
              >
                <ui-trash2 class="size-3.5" />
              </ui-button>
            </div>
          </li>
        </ul>
        <div v-else class="panel-body">
          <p class="panel-empty">暂无会话</p>
        </div>
      </div>
    </aside>
    </ui-resizable-panel>

    <ui-resizable-handle aria-label="拖拽调整会话历史宽度" />

    <!-- 当前会话 -->
    <ui-resizable-panel :default-size="30" :min-size="15" :max-size="40" class="min-w-0">
      <section class="tool-chat panel">
        <header class="panel-header flex items-center justify-between gap-2">
          <h2 class="panel-title">当前会话</h2>
      </header>

      <div class="flex min-h-0 flex-1 flex-col">
        <div class="min-h-0 flex-1 space-y-3 overflow-y-auto scroll-gap px-4 py-3">
          <div v-if="messages.length === 0" class="flex h-full items-center justify-center">
            <p class="panel-empty">描述需求，AI 会重写这个工具页面</p>
          </div>
          <div
            v-for="m in messages"
            :key="m.id"
            class="flex flex-col gap-1.5"
            :class="m.role === 'user' ? 'items-end' : 'items-start'"
          >
            <!-- 思考过程：独立卡片，与回复气泡分开（仅 AI 且有实际思考内容时显示） -->
            <div
              v-if="m.role === 'ai' && thinkOf(m)"
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
              :class="m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'"
            >
              <template v-if="m.role === 'user'">{{ m.content }}</template>
              <template v-else>
                {{ answerOf(m) || (draft && draft.id === m.id ? '正在思考…' : '') }}
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
                  <ui-button size="sm" @click="applyPending(m.id)">应用</ui-button>
                  <ui-button
                    size="sm"
                    variant="outline"
                    :disabled="streaming"
                    @click="discardPending(m.id)"
                  >
                    放弃
                  </ui-button>
                </template>
                <span
                  v-else-if="pendingOf(m.id)?.status === 'applied'"
                  class="text-xs text-green-600"
                >
                  已应用到当前工具
                </span>
                <span v-else class="text-xs text-muted-foreground">已放弃本次改动</span>
              </div>
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
              class="min-h-[78px] max-h-32 w-full resize-none overflow-y-auto scroll-gap bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="例如：做一个能读取本地文件并用 Markdown 展示的工具"
              :disabled="streaming"
              @keydown.enter.exact.prevent="send"
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
              <ui-button v-if="streaming" variant="outline" size="sm" @click="stopGeneration">
                停止
              </ui-button>
              <ui-button size="sm" :disabled="streaming || !input.trim()" @click="send">
                发送
              </ui-button>
            </div>
          </div>
        </div>
      </div>
      </section>
      </ui-resizable-panel>

      <ui-resizable-handle aria-label="拖拽调整工具详情宽度" />

      <!-- 工具详情：嵌入工具自身 index.html（tool:// 协议承载） -->
      <ui-resizable-panel :default-size="50" :min-size="30" :max-size="60" class="min-w-0">
        <section class="tool-detail panel">
      <header class="panel-header flex items-center justify-between gap-2">
        <h2 class="panel-title">
          <tool-icon :icon="props.tool.icon" :fallback="props.tool.title" class="text-sm" />
          工具详情
        </h2>
        <ui-button
          variant="ghost"
          size="icon"
          class="no-drag size-7"
          aria-label="查看版本历史"
          title="查看版本历史"
          @click="emit('openHistory', props.tool)"
        >
          <ui-git-branch class="size-4" />
        </ui-button>
      </header>

      <tool-frame ref="frameRef" :tool="props.tool" />
        </section>
        </ui-resizable-panel>

        <!-- 删除确认浮层：跟随点击位置弹出，type 决定文案与删除目标（单个 / 全部） -->
        <teleport to="body">
          <div v-if="deleteConfirm" class="fixed inset-0 z-50" @click="cancelDelete">
        <div
          class="bg-popover text-popover-foreground absolute w-56 rounded-md border p-3 shadow-md outline-none"
          :style="confirmStyle"
          @click.stop
        >
          <p class="text-xs">
            {{
              deleteConfirm.type === 'all'
                ? '确定删除所有会话吗？删除后全部聊天记录将不可恢复。'
                : `确定删除会话「${deleteConfirm.title}」吗？删除后聊天记录将不可恢复。`
            }}
          </p>
          <div class="mt-2 flex items-center justify-end gap-2">
            <ui-button variant="outline" size="sm" @click="cancelDelete">取消</ui-button>
            <ui-button variant="destructive" size="sm" @click="confirmDelete">删除</ui-button>
          </div>
        </div>
      </div>
    </teleport>
  </ui-resizable-panel-group>
</template>
