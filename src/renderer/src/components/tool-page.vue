<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  Popover as UiPopover,
  PopoverContent as UiPopoverContent,
  PopoverTrigger as UiPopoverTrigger
} from '@/components/ui/popover'
import { parseGeneratedChanges, type GeneratedChangeList } from '@/lib/tool-generator'
import {
  Check as UiCheck,
  ChevronRight as UiChevronRight,
  ChevronsUpDown as UiChevronsUpDown,
  ListTodo as UiListTodo,
  PanelRightClose as UiPanelRightClose,
  Plus as UiPlus
} from '@lucide/vue'

// 一个工具标签页的标识：唯一 ID（决定 tool:// 源与工具文件夹名）+ 展示名
export interface ToolPageMeta {
  id: string
  title: string
}

const props = defineProps<{ tool: ToolPageMeta }>()

// 工具自身界面：由 tool:// 协议承载 <userData>/tools/<id>/index.html，嵌入「工具详情」栏
const toolUrl = `tool://${props.tool.id}/index.html`

// 工具详情 <webview> 运行状态：加载失败 / 崩溃 / 死循环无响应时显示错误覆盖层，并提供重载
type FrameStatus = 'loading' | 'ok' | 'hang' | 'error' | 'crash'
const frameStatus = ref<FrameStatus>('loading')
const frameDetail = ref('')

// <webview> 需指定的 guest preload（注入 window.cap + 心跳），该路径由主进程返回编译产物绝对路径
const webviewRef = ref<HTMLElement & { reload: () => void } | null>(null)
const preloadPath = ref('')

// —— 心跳 watchdog：guest preload 通过 sendToHost 每 2s 报活 ——
// 工具页若陷入死循环，事件循环被饿死、心跳停止，宿主据此判定卡死。
const HEARTBEAT_TOKEN = '__duo_ling_heartbeat__'
const HEARTBEAT_TIMEOUT_MS = 6000
const HEARTBEAT_CHECK_MS = 2000

let lastHeartbeat = 0
let heartbeatTimer: number | undefined = undefined

function onIpcMessage(e: Event): void {
  const msg = e as Event & { channel?: unknown }
  if (msg.channel !== HEARTBEAT_TOKEN) return
  lastHeartbeat = Date.now()
  if (frameStatus.value === 'hang' || frameStatus.value === 'loading') frameStatus.value = 'ok'
}

function onDidFailLoad(e: Event): void {
  const ev = e as Event & { errorCode?: number; errorDescription?: string }
  frameStatus.value = 'error'
  frameDetail.value = ev.errorDescription || `加载失败(${ev.errorCode ?? '?'})`
}

function onRenderGone(e: Event): void {
  const ev = e as Event & { reason?: string }
  frameStatus.value = 'crash'
  frameDetail.value = ev.reason || ''
}

function onDomReady(): void {
  if (frameStatus.value !== 'error' && frameStatus.value !== 'crash') frameStatus.value = 'ok'
}

function startHeartbeatWatch(): void {
  lastHeartbeat = Date.now()
  window.clearInterval(heartbeatTimer)
  heartbeatTimer = window.setInterval(() => {
    if (frameStatus.value === 'error' || frameStatus.value === 'crash') return
    if (Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      frameStatus.value = 'hang'
      frameDetail.value = '工具页面无响应（可能陷入死循环）'
    }
  }, HEARTBEAT_CHECK_MS)
}

function reloadFrame(): void {
  frameStatus.value = 'loading'
  frameDetail.value = ''
  lastHeartbeat = Date.now()
  webviewRef.value?.reload()
}

// preloadPath 就绪后把 <webview> 挂进 DOM，再绑定 guest 事件（did-fail-load / crash / ipc-message）
watch(preloadPath, async (p) => {
  if (!p) return
  await nextTick()
  const wv = webviewRef.value
  if (!wv) return
  wv.addEventListener('ipc-message', onIpcMessage)
  wv.addEventListener('did-fail-load', onDidFailLoad)
  wv.addEventListener('render-process-gone', onRenderGone)
  wv.addEventListener('dom-ready', onDomReady)
})

onUnmounted(() => {
  window.clearInterval(heartbeatTimer)
  window.api.generator.offEvent()
})

// 会话 / 对话为本地占位状态：切换会话、新建会话仅在前端演示
// 「当前会话」已接入生成器：消息发送 → LLM 产出工具 JSON → 写入当前工具 index.html + meta.json
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

const emit = defineEmits<{ renamed: [id: string, title: string]; openSettings: [] }>()

const sessions = ref<ToolSession[]>([])
const activeSessionId = ref('')
const messages = ref<ToolChatMessage[]>([])
const input = ref('')
const streaming = ref(false)
const draft = ref<ToolChatMessage | null>(null)

// —— 审批模式：全局默认来自设置（settings），当前会话内可在此临时切换 ——
// manual：AI 产出变更清单后由用户点「应用/丢弃」；auto：AI 改完直接落盘。
type ApprovalMode = 'manual' | 'auto'
const approvalMode = ref<ApprovalMode>('manual')

// 待审批的变更清单：绑定到某条 AI 消息上，用户确认后应用
interface PendingChange {
  messageId: string
  changes: GeneratedChangeList
  status: 'pending' | 'applied' | 'discarded'
  error?: string
}
const pendingChange = ref<PendingChange | null>(null)

onMounted(async () => {
  startHeartbeatWatch()
  window.api.generator.onEvent(onGeneratorEvent)
  void window.api.tool.getPreloadPath().then((p) => {
    preloadPath.value = p
  })
  void window.api.model.list().then(refreshModelStatus)
  // 会话级审批模式默认取全局设置，之后再在会话内临时切换
  approvalMode.value = await window.api.settings.getGeneratorApprovalMode()
})

async function setApprovalMode(mode: ApprovalMode): Promise<void> {
  if (mode === approvalMode.value) return
  approvalMode.value = mode
}

// —— 思考过程可视化：把 <think>...</think> 拆为「思考内容」与「答案」两部分 ——
function splitContent(content: string): { think: string; answer: string } {
  const open = content.indexOf('<think>')
  if (open === -1) return { think: '', answer: content.trim() }
  const rest = content.slice(open + '<think>'.length)
  const close = rest.indexOf('</think>')
  if (close === -1) return { think: rest.trim(), answer: '' }
  return { think: rest.slice(0, close).trim(), answer: rest.slice(close + '</think>'.length).trim() }
}

const thinkOf = (m: ToolChatMessage): string => splitContent(m.content).think
const answerOf = (m: ToolChatMessage): string => splitContent(m.content).answer

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
        if (approvalMode.value === 'auto') {
          // 自动审批：AI 改完直接落盘；失败错误由 applyChanges 回填到消息
          await applyChanges(draftMsg.id, parsed.changes)
        } else {
          pendingChange.value = { messageId: draftMsg.id, changes: parsed.changes, status: 'pending' }
        }
      }
    } else if (res.error) {
      messages.value = messages.value.filter((m) => m.id !== draftMsg.id)
    }
  } catch (error) {
    messages.value = messages.value.filter((m) => m.id !== draftMsg.id)
  } finally {
    draft.value = null
    streaming.value = false
  }
}

// 应用变更清单：调用主进程落盘，成功则同步标签名并刷新工具页
async function applyChanges(messageId: string, changes: GeneratedChangeList): Promise<void> {
  const current = pendingChange.value
  let updated: Awaited<ReturnType<typeof window.api.tool.update>>
  try {
    // changes 可能来自响应式 ref（pendingChange.changes），实为 Vue 的 reactive Proxy，
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
    }
    if (updated.title) emit('renamed', props.tool.id, updated.title)
    reloadFrame()
  } else {
    const err = updated.error ?? '未知错误'
    // 手动模式：在卡片里展示错误，并保留「应用/放弃」按钮供用户重试或放弃
    if (current && current.messageId === messageId) {
      current.error = err
      return
    }
    // 自动模式（无卡片可挂载）：把错误回填到消息正文
    const msg = messages.value.find((m) => m.id === messageId)
    if (msg) msg.content += `\n\n[写入工具失败] ${err}`
  }
}

function applyPending(messageId: string): void {
  const current = pendingChange.value
  if (current && current.messageId === messageId && current.status === 'pending') {
    void applyChanges(messageId, current.changes)
  }
}

function discardPending(messageId: string): void {
  const current = pendingChange.value
  if (current && current.messageId === messageId && current.status === 'pending') {
    current.status = 'discarded'
  }
}

async function stopGeneration(): Promise<void> {
  await window.api.generator.abort()
}

// 三栏宽度：左右两栏可通过分隔条拖拽调节
const sessWidth = ref(260)
const detailWidth = ref(380)
const MIN_WIDTH = 200
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
</script>

<template>
  <div class="tool-page">
    <!-- 会话历史 -->
    <aside class="tool-sess panel" :style="{ width: sessWidth + 'px' }">
      <header class="panel-header flex items-center justify-between gap-2">
        <div class="flex items-center gap-1">
          <h2 class="panel-title flex items-center gap-2">
            <ui-list-todo class="size-4" />
            会话历史
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
      aria-label="拖拽调整会话历史宽度"
      @mousedown="startResize($event, 'sess')"
    />

    <!-- 当前会话 -->
    <section class="tool-chat panel">
      <header class="panel-header flex items-center justify-between gap-2">
        <h2 class="panel-title">当前会话</h2>
        <!-- 审批模式：会话内可临时切换（全局默认在「设置」中配置） -->
        <div class="flex items-center gap-1 rounded-md border border-input p-0.5 text-xs">
          <button
            type="button"
            class="rounded px-2 py-0.5 transition-colors"
            :class="approvalMode === 'manual' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'"
            :aria-pressed="approvalMode === 'manual'"
            @click="setApprovalMode('manual')"
          >
            手动审批
          </button>
          <button
            type="button"
            class="rounded px-2 py-0.5 transition-colors"
            :class="approvalMode === 'auto' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'"
            :aria-pressed="approvalMode === 'auto'"
            @click="setApprovalMode('auto')"
          >
            自动应用
          </button>
        </div>
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
                class="mt-1.5 whitespace-pre-wrap"
              >
                {{ thinkOf(m) }}
              </div>
            </div>
            <!-- 消息气泡 -->
            <div
              class="max-w-[80%] rounded-lg px-3 py-2 text-sm"
              :class="m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'"
            >
              <template v-if="m.role === 'user'">{{ m.content }}</template>
              <template v-else>
                {{ answerOf(m) || (draft && draft.id === m.id ? '正在思考…' : '') }}
              </template>
            </div>
            <!-- 变更清单卡片：AI 产出改动后，手动模式下请用户确认是否应用 -->
            <div
              v-if="m.role === 'ai' && pendingChange && pendingChange.messageId === m.id"
              class="max-w-[80%] rounded-lg border border-border bg-background/60 px-3 py-2"
              data-testid="change-card"
            >
              <p class="text-xs font-medium">
                {{ pendingChange.changes.summary || 'AI 建议对当前工具做以下改动' }}
              </p>
              <ul class="mt-1.5 space-y-1 text-xs text-muted-foreground">
                <li v-for="(a, i) in pendingChange.changes.actions" :key="i">
                  <span class="font-mono">{{ a.op }}</span> {{ a.file }}
                  <template v-if="a.op === 'patch' && a.find">：{{ truncate(a.find) }}…</template>
                </li>
              </ul>
              <!-- 应用失败提示 -->
              <p
                v-if="pendingChange.error"
                class="mt-1.5 text-xs text-destructive"
                data-testid="change-error"
              >
                {{ pendingChange.error }}
              </p>
              <div class="mt-2 flex items-center gap-2">
                <template v-if="pendingChange.status === 'pending'">
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
                <span v-else-if="pendingChange.status === 'applied'" class="text-xs text-green-600">
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

    <div
      class="tool-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="拖拽调整工具详情宽度"
      @mousedown="startResize($event, 'detail')"
    />

    <!-- 工具详情：嵌入工具自身 index.html（tool:// 协议承载） -->
    <section class="tool-detail panel" :style="{ width: detailWidth + 'px' }">
      <header class="panel-header">
        <h2 class="panel-title">工具详情</h2>
      </header>

      <div class="tool-detail-body">
        <webview
          v-if="preloadPath"
          ref="webviewRef"
          v-show="frameStatus !== 'error' && frameStatus !== 'crash' && frameStatus !== 'hang'"
          class="tool-frame"
          :src="toolUrl"
          :preload="preloadPath"
          :title="tool.title"
        />
        <div
          v-if="frameStatus === 'error' || frameStatus === 'crash' || frameStatus === 'hang'"
          class="tool-frame-error"
        >
          <p class="tool-frame-error__title">
            {{ frameStatus === 'crash' ? '工具页面已崩溃' : frameStatus === 'hang' ? '工具页面无响应' : '工具页面加载失败' }}
          </p>
          <p class="tool-frame-error__detail">{{ frameDetail }}</p>
          <ui-button size="sm" @click="reloadFrame">重新加载</ui-button>
        </div>
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
  min-height: 0;
}

.tool-chat {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.tool-detail-body {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

.tool-frame {
  width: 100%;
  height: 100%;
  border: 0;
  background: var(--background);
}

.tool-frame-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  background: var(--background);
}

.tool-frame-error__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
}

.tool-frame-error__detail {
  font-size: 12px;
  color: var(--muted-foreground);
}
</style>
