<script setup lang="ts">
// side panel 宿主：应用入口 = AI 对话界面。
//
// 本组件只做两件事：
//   1. 装配 —— 把 useGlobalConversation 的状态接到复用自桌面版的 ChatPanel / SessionHistoryPanel；
//   2. 载体适配 —— 顶栏入口、打开工作台标签页。
// 消息渲染、思考过程折叠、工具调用卡、输入区、模型切换全部由平移组件提供，此处不重写任何对话 UI。
//
// 载体分工：工具代码 / 版本 / 设置这类重界面走独立标签页（entrypoints/workbench.html，hash 路由）。
import { computed, onMounted, ref } from 'vue'
import {
  ExternalLink as UiExternalLink,
  PanelLeft as UiPanelLeft,
  Plus as UiPlus,
  Settings as UiSettings
} from '@lucide/vue'
import ChatPanel from '@/components/ChatPanel.vue'
import SessionHistoryPanel from '@/components/SessionHistoryPanel.vue'
import { Button as UiButton } from '@/components/ui/button'
import { useGlobalConversation } from '@/composables/use-global-conversation'

const {
  conversations,
  activeConversationId,
  messages,
  pendingMap,
  usageByMessageId,
  streaming,
  loadConversations,
  newConversation,
  activateConversation,
  deleteConversation,
  deleteAllConversations,
  renameConversation,
  send,
  stopGeneration
} = useGlobalConversation()

/** 会话记录面板：side panel 宽度有限，做成覆盖式而非常驻栏 */
const sessionsOpen = ref(false)

const activeTitle = computed(
  () => conversations.value.find((c) => c.id === activeConversationId.value)?.title || '哆灵'
)

/** 工作台是独立标签页，用 hash 指定初始落点（#/tools、#/tool/<id>/<tab>、#/settings） */
function openWorkbench(hash = ''): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('workbench.html') + hash })
}

function handleNew(): void {
  sessionsOpen.value = false
  void newConversation()
}

function handleActivate(id: string): void {
  sessionsOpen.value = false
  void activateConversation(id)
}

function onDeleteConversation(payload: {
  type: 'session' | 'all'
  id?: string
  title?: string
}): void {
  if (payload.type === 'session' && payload.id) void deleteConversation(payload.id)
  else void deleteAllConversations()
}

function onRenameConversation(payload: { id: string; title: string }): void {
  void renameConversation(payload.id, payload.title)
}

onMounted(() => {
  void loadConversations()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background text-foreground">
    <header class="flex h-11 shrink-0 items-center gap-0.5 border-b border-border px-2">
      <ui-button
        variant="ghost"
        size="icon"
        class="size-7 shrink-0"
        title="会话记录"
        @click="sessionsOpen = !sessionsOpen"
      >
        <ui-panel-left class="size-4" />
      </ui-button>

      <div class="min-w-0 flex-1 truncate px-1 text-sm font-medium">{{ activeTitle }}</div>

      <ui-button
        variant="ghost"
        size="icon"
        class="size-7 shrink-0"
        title="新建会话"
        @click="handleNew"
      >
        <ui-plus class="size-4" />
      </ui-button>
      <ui-button
        variant="ghost"
        size="icon"
        class="size-7 shrink-0"
        title="打开工作台"
        @click="openWorkbench()"
      >
        <ui-external-link class="size-4" />
      </ui-button>
      <ui-button
        variant="ghost"
        size="icon"
        class="size-7 shrink-0"
        title="设置"
        @click="openWorkbench('#/settings')"
      >
        <ui-settings class="size-4" />
      </ui-button>
    </header>

    <div class="relative min-h-0 flex-1">
      <!-- 会话记录：覆盖式面板，选中即收起 -->
      <div v-if="sessionsOpen" class="absolute inset-0 z-10 bg-background">
        <session-history-panel
          class="h-full"
          :conversations="conversations"
          :active-conversation-id="activeConversationId"
          @activate="handleActivate"
          @new="handleNew"
          @delete="onDeleteConversation"
          @rename="onRenameConversation"
        />
      </div>

      <chat-panel
        class="h-full"
        :messages="messages"
        :pending-map="pendingMap"
        :usage-by-message-id="usageByMessageId"
        :streaming="streaming"
        @send="send"
        @stop="stopGeneration"
        @open-settings="openWorkbench('#/settings')"
      />
    </div>
  </div>
</template>
