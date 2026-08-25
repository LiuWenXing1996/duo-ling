<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import {
  ResizableHandle as UiResizableHandle,
  ResizablePanel as UiResizablePanel,
  ResizablePanelGroup as UiResizablePanelGroup
} from '@/components/ui/resizable'
import { parseGeneratedChanges, type GeneratedChangeList } from '@/lib/tool-generator'
import { useToolSessions, type ToolChatMessage } from '@/composables/use-tool-sessions'
import type { GeneratorEventData } from '../../../shared/types'
import SessionHistoryPanel from '@/components/SessionHistoryPanel.vue'
import ChatPanel from '@/components/ChatPanel.vue'
import ToolDetailPanel from '@/components/ToolDetailPanel.vue'

// 一个工具标签页的标识：唯一 ID（决定 tool:// 源与工具文件夹名）+ 展示名
export interface ToolPageMeta {
  id: string
  title: string
  /** 工具图标（单个字符），可选；用于工具详情头部展示 */
  icon?: string
}

const props = defineProps<{ tool: ToolPageMeta }>()

const emit = defineEmits<{
  renamed: [id: string, title: string]
  openSettings: []
  openHistory: [tool: ToolPageMeta]
}>()

// —— 生成/发送状态（非会话持久化职责，留在本组件）——
const streaming = ref(false)
const draft = ref<ToolChatMessage | null>(null)

// —— 工具详情栏 ref：生成器改动落盘后重载工具页 ——
const detailRef = ref<InstanceType<typeof ToolDetailPanel> | null>(null)

// —— 会话状态：多会话列表 + 消息分桶 + 本地持久化（抽至 composable）——
const {
  sessions,
  activeSessionId,
  messages,
  pendingMap,
  restore,
  newSession,
  activateSession,
  deleteSession,
  deleteAllSessions,
  saveSessions
} = useToolSessions(() => props.tool.id, {
  clearDraft: () => {
    draft.value = null
  }
})

onMounted(() => {
  window.api.generator.onEvent(onGeneratorEvent)
  // 恢复本工具的会话历史（多会话：切换回显 + 本地持久化），无可用会话时自动新建
  restore()
})

onUnmounted(() => {
  window.api.generator.offEvent()
})

// 根据首条用户输入生成会话标题摘要，便于在「会话历史」中辨认
function summarizeTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > 12 ? `${t.slice(0, 12)}…` : t
}

// —— 删除会话：单个 / 全部（删除确认浮层在 session-history-panel 内自含）——
function onDeleteSession(payload: { type: 'session' | 'all'; id?: string; title?: string }): void {
  if (payload.type === 'session' && payload.id) deleteSession(payload.id)
  else deleteAllSessions()
}

// 生成器流式事件：把增量累积到待生成的草稿消息，同时把 Agent Loop 的工具调用事件累积到草稿的 steps。
// done/aborted/error 由 send 收尾，避免重复处理。
function onGeneratorEvent(payload: GeneratorEventData): void {
  if (!draft.value) return
  if (payload.type === 'token') {
    draft.value.content += payload.token
    return
  }
  // 思考流程：流式期间即时累积到草稿的 reasoning，思考卡片当轮即可显示，不需等下一轮 re-render
  if (payload.type === 'reasoning') {
    if (!draft.value.reasoning) draft.value.reasoning = ''
    draft.value.reasoning += payload.text
    return
  }
  // AI 自主调用工具：逐步累积到草稿的 steps，供渲染层展示「正在调用工具」步骤卡片
  if (payload.type === 'tool_start') {
    if (!draft.value.steps) draft.value.steps = []
    draft.value.steps.push({
      id: `t-${draft.value.steps.length}-${Date.now()}`,
      name: payload.name,
      arguments: payload.arguments,
      status: 'running'
    })
    return
  }
  if (payload.type === 'tool_result') {
    // 用最后一个「同名且仍在运行」的步骤配对结果（骨架期同名工具极少并发，足够可靠）
    const target = [...(draft.value.steps ?? [])]
      .reverse()
      .find((s) => s.name === payload.name && s.status === 'running')
    if (target) {
      target.status = payload.ok ? 'done' : 'error'
      target.result = payload.result
      target.error = payload.error
    }
  }
}

// 发送：加入用户消息 -> 流式调用生成器 -> 解析产出变更并应用（自动落盘）
async function send(text: string): Promise<void> {
  if (!text || streaming.value) return

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
    // 流式过程中 draftMsg.reasoning 已由 onGeneratorEvent 累积；send 返回的 reasoning 兜底回填
    if (res.reasoning) draftMsg.reasoning = res.reasoning
    if (res.content) {
      draftMsg.content = res.content
      const parsed = parseGeneratedChanges(res.content)
      // changes 为 null：可视作 LLM 在澄清追问 / 能力缺失说明，保留原文作为普通回复
      if (parsed.changes) {
        // 有实际改动：正文不再直出契约 JSON，改用 summary 作为人类可读回复
        draftMsg.content = parsed.changes.summary?.trim() || '已生成对当前工具的改动并应用'
        // 自动落盘：AI 改完直接应用；先把变更清单记入卡片作留痕，失败错误由 applyChanges 回填到卡片
        pendingMap.value[draftMsg.id] = {
          messageId: draftMsg.id,
          changes: parsed.changes
        }
        saveSessions()
        await applyChanges(draftMsg.id, parsed.changes)
      } else if (parsed.summary) {
        // LLM 输出的是「无实际动作」的契约 JSON（多为澄清追问）：把直出的原始 JSON 替换为人性化 summary
        draftMsg.content = parsed.summary
      } else {
        // 普通对话（打招呼/闲聊）：无可应用变更，正文非空则原样展示，空则兜底避免空白气泡
        ensureNonEmptyAnswer(draftMsg)
      }
    } else if (res.error) {
      messages.value = messages.value.filter((m) => m.id !== draftMsg.id)
    } else {
      // 模型返回了空内容且无错误：同样兜底，避免渲染出空白气泡
      ensureNonEmptyAnswer(draftMsg)
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
    if (updated.title) emit('renamed', props.tool.id, updated.title)
    detailRef.value?.reload()
  } else {
    const err = updated.error ?? '未知错误'
    // 在留痕卡片里展示错误（纯自动落盘，卡片仅作留痕展示）
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

// 兜底：模型只思考而无正文 / 返回空内容时，给消息补一段人类可读文案，避免空白气泡。
// 思考过程已存于 msg.reasoning，正文缺失时仅追加说明，不拼接 <think> 标签。
function ensureNonEmptyAnswer(msg: ToolChatMessage): void {
  if (msg.content.trim()) return
  msg.content = '（模型未生成回复内容，请重试或换个说法）'
}

async function stopGeneration(): Promise<void> {
  await window.api.generator.abort()
}
</script>

<template>
  <ui-resizable-panel-group direction="horizontal" class="tool-page h-full w-full">
    <!-- 会话历史 -->
    <ui-resizable-panel :default-size="20" :min-size="15" :max-size="40" class="min-w-0">
      <session-history-panel
        :sessions="sessions"
        :active-session-id="activeSessionId"
        @activate="activateSession"
        @new="newSession"
        @delete="onDeleteSession"
      />
    </ui-resizable-panel>

    <ui-resizable-handle aria-label="拖拽调整会话历史宽度" />

    <!-- 当前会话 -->
    <ui-resizable-panel :default-size="30" :min-size="15" :max-size="40" class="min-w-0">
      <chat-panel
        :messages="messages"
        :pending-map="pendingMap"
        :streaming="streaming"
        :draft="draft"
        @send="send"
        @stop="stopGeneration"
        @open-settings="$emit('openSettings')"
      />
    </ui-resizable-panel>

    <ui-resizable-handle aria-label="拖拽调整工具详情宽度" />

    <!-- 工具详情 -->
    <ui-resizable-panel :default-size="50" :min-size="30" :max-size="60" class="min-w-0">
      <tool-detail-panel
        ref="detailRef"
        :tool="props.tool"
        @open-history="$emit('openHistory', $event)"
      />
    </ui-resizable-panel>
  </ui-resizable-panel-group>
</template>
