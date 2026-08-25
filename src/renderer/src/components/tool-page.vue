<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import {
  ResizableHandle as UiResizableHandle,
  ResizablePanel as UiResizablePanel,
  ResizablePanelGroup as UiResizablePanelGroup
} from '@/components/ui/resizable'
import { parseGeneratedChanges, type GeneratedChangeList } from '@/lib/tool-generator'
import { isContractAnswer, splitContent } from '@/lib/message-format'
import { useToolSessions, type ToolChatMessage } from '@/composables/use-tool-sessions'
import SessionHistoryPanel from '@/components/session-history-panel.vue'
import ChatPanel from '@/components/chat-panel.vue'
import ToolDetailPanel from '@/components/tool-detail-panel.vue'

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
// 「假流式」打字机进度：messageId -> 已显示字符数（由 send 完成后驱动）
const typing = ref<Record<string, number>>({})

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
  saveSessions,
  pendingOf
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
    detailRef.value?.reload()
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
  const current = pendingOf(messageId)
  if (current && current.messageId === messageId && current.status === 'pending') {
    void applyChanges(messageId, current.changes)
  }
}

function discardPending(messageId: string): void {
  const current = pendingOf(messageId)
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
        :typing="typing"
        :streaming="streaming"
        :draft="draft"
        @send="send"
        @stop="stopGeneration"
        @apply-pending="applyPending"
        @discard-pending="discardPending"
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
