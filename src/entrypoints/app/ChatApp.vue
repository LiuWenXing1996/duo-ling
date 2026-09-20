<script setup lang="ts">
// side panel 宿主：应用入口 = AI 对话界面。
//
// 布局：顶栏最左侧一个「会话列表」按钮，点击后左侧滑出浮层抽屉（半透明遮罩 + 会话列表面板），
//       聊天区不被挤窄；选中会话 / 点遮罩 / 面板内收起即关。
// 会话列表走 SessionHistoryPanel（展开态）；消息渲染、模型切换等全部由平移组件提供，此处不重写对话 UI。
import { computed, onMounted, ref } from 'vue'
import {
  LayoutDashboard as UiLayoutDashboard,
  PanelLeft as UiPanelLeft,
  Plus as UiPlus,
  TriangleAlert as UiTriangleAlert
} from '@lucide/vue'
import ChatPanel from '@/components/ChatPanel.vue'
import PageScriptsMonitor from '@/components/PageScriptsMonitor.vue'
import SessionHistoryPanel from '@/components/SessionHistoryPanel.vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger
} from '@/components/ui/tooltip'
import { useGlobalConversation } from '@/composables/use-global-conversation'

const {
  conversations,
  activeConversationId,
  messages,
  usageByMessageId,
  orphanTasks,
  chatError,
  streaming,
  loadConversations,
  newConversation,
  activateConversation,
  deleteConversation,
  deleteAllConversations,
  renameConversation,
  resolveOrphan,
  send,
  stopGeneration
} = useGlobalConversation()

const activeTitle = computed(
  () => conversations.value.find((c) => c.id === activeConversationId.value)?.title || '哆灵'
)

/** 侧边栏展开态：浮层抽屉（默认收起）；选中会话 / 点遮罩 / 面板内收起即关 */
const sidebarExpanded = ref(false)
function toggleSidebar(): void {
  sidebarExpanded.value = !sidebarExpanded.value
}

/** 工作台是独立标签页，用 hash 指定初始落点（#/tools、#/tool/<id>/<tab>、#/settings） */
function openWorkbench(hash = ''): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('workbench.html') + hash })
}

function handleNew(): void {
  void newConversation()
}

function handleActivate(id: string): void {
  sidebarExpanded.value = false
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
  // 面板存活端口：长连接给 SW 做「面板开着没」的判定（onDisconnect = 面板关了），
  // SW 据此决定生成完成时是否亮图标角标。连接须持有引用防 GC——断开由 SW 侧 onDisconnect 感知。
  connectKeepAlive()
})

/** 面板存活端口；模块级持有，面板文档存续期间不断开 */
let panelPort: chrome.runtime.Port | null = null
function connectKeepAlive(): void {
  try {
    panelPort = chrome.runtime.connect({ name: 'duoling:panel' })
    // 仅持有引用防 GC（见上注释），无读取方——显式消费以免 noUnusedLocals 报错
    void panelPort
  } catch {
    // SW 尚未起等场景：尽力而为，badge 判定退化为「面板关着」也无大碍
  }
}
</script>

<template>
  <div class="relative flex h-full min-h-0 flex-col bg-background text-foreground">
    <header class="flex h-11 shrink-0 items-center gap-0.5 border-b border-border px-2">
      <!-- 会话列表入口：顶栏最左侧一个按钮，点开左侧浮层抽屉 -->
      <ui-tooltip-provider>
        <ui-tooltip>
          <ui-tooltip-trigger as-child>
            <ui-button
              variant="ghost"
              size="icon"
              class="size-7 shrink-0"
              aria-label="会话列表"
              @click="toggleSidebar"
            >
              <ui-panel-left class="size-4" />
            </ui-button>
          </ui-tooltip-trigger>
          <ui-tooltip-content>会话列表</ui-tooltip-content>
        </ui-tooltip>
      </ui-tooltip-provider>

      <div class="min-w-0 flex-1 truncate px-1 text-sm font-medium" :title="activeTitle">
        {{ activeTitle }}
      </div>
      <ui-tooltip-provider>
        <ui-tooltip>
          <ui-tooltip-trigger as-child>
            <ui-button
              variant="ghost"
              size="icon"
              class="size-7 shrink-0"
              aria-label="新建会话"
              @click="handleNew"
            >
              <ui-plus class="size-4" />
            </ui-button>
          </ui-tooltip-trigger>
          <ui-tooltip-content>新建会话</ui-tooltip-content>
        </ui-tooltip>
      </ui-tooltip-provider>
      <ui-tooltip-provider>
        <ui-tooltip>
          <ui-tooltip-trigger as-child>
            <ui-button
              variant="ghost"
              size="icon"
              class="size-7 shrink-0"
              aria-label="打开工作台"
              @click="openWorkbench()"
            >
              <ui-layout-dashboard class="size-4" />
            </ui-button>
          </ui-tooltip-trigger>
          <ui-tooltip-content>打开工作台</ui-tooltip-content>
        </ui-tooltip>
      </ui-tooltip-provider>
    </header>

    <!-- 孤儿任务横幅：offscreen 宿主被杀后遗留的进行中任务 -->
    <div
      v-if="orphanTasks.length"
      class="shrink-0 border-b border-border bg-amber-500/10 px-3 py-2 text-xs text-foreground"
      data-testid="orphan-banner"
    >
      <div
        v-for="task in orphanTasks"
        :key="task.taskId"
        class="flex items-center gap-2 py-0.5"
      >
        <ui-triangle-alert class="size-3.5 shrink-0 text-amber-600" />
        <span class="min-w-0 flex-1 truncate">
          上次脚本生成中断在第 {{ task.step }} 步，产物尚未保存
        </span>
        <ui-button
          size="xs"
          variant="outline"
          :disabled="streaming"
          @click="void resolveOrphan(task.taskId, 'continue')"
        >
          继续
        </ui-button>
        <ui-button
          size="xs"
          variant="ghost"
          class="text-destructive hover:text-destructive"
          @click="void resolveOrphan(task.taskId, 'discard')"
        >
          丢弃
        </ui-button>
      </div>
    </div>

    <!-- 页面脚本监控 · 灵动岛：左侧当前页实际运行的脚本，悬浮胶囊（无事不渲染） -->
    <page-scripts-monitor />

    <chat-panel
      class="min-h-0 flex-1"
      :messages="messages"
      :usage-by-message-id="usageByMessageId"
      :streaming="streaming"
      :error-text="chatError"
      @send="send"
      @stop="stopGeneration"
      @open-settings="openWorkbench('#/settings')"
      @open-guide="openWorkbench('#/guide')"
    />

    <!-- 展开态浮层：半透明遮罩 + 左侧滑出抽屉；聊天区不被挤窄 -->
    <div
      class="absolute inset-0 z-20 bg-black/30 transition-opacity duration-200"
      :class="sidebarExpanded ? 'opacity-100' : 'pointer-events-none opacity-0'"
      @click="toggleSidebar"
    />
    <div
      class="absolute left-0 top-0 z-30 flex h-full w-[280px] max-w-[85%] flex-col border-r border-border bg-background shadow-xl transition-all duration-200 ease-out"
      :class="sidebarExpanded ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0'"
    >
      <session-history-panel
        class="min-h-0 flex-1"
        :conversations="conversations"
        :active-conversation-id="activeConversationId"
        @activate="handleActivate"
        @new="handleNew"
        @delete="onDeleteConversation"
        @rename="onRenameConversation"
        @close="toggleSidebar"
      />
    </div>
  </div>
</template>
