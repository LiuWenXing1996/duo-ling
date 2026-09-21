<script setup lang="ts">
// 对话界面宿主：side panel（侧边栏）与网页浮层共用同一份实现。
//
// 布局：顶栏 = 当前会话标题 + 两个去处（会话历史 / 工作台）；下方是消息区与输入区。
//
// **会话归属按标签页**（一个 tab 一条会话，切 tab 即切会话）—— 所以这里**没有**会话列表、
// 没有「新建会话」：要开一段新对话就开个新标签页；要回看旧对话就去工作台的「会话历史」
// 标签页（查看 + 改名 / 删除）。归属解析与惰性新建都在 use-global-conversation 里，
// 本组件不做任何会话归属的判断。
//
// 顶栏标题取当前会话标题；未绑定态（这个 tab 还没发过消息）显示应用名。
import { computed, onMounted } from 'vue'
import {
  History as UiHistory,
  LayoutDashboard as UiLayoutDashboard,
  TriangleAlert as UiTriangleAlert
} from '@lucide/vue'
import ChatPanel from '@/components/ChatPanel.vue'
import PageScriptsMonitor from '@/components/PageScriptsMonitor.vue'
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
  resolveOrphan,
  send,
  stopGeneration
} = useGlobalConversation()

const activeTitle = computed(
  () => conversations.value.find((c) => c.id === activeConversationId.value)?.title || '哆灵'
)

/** 工作台是独立标签页，用 hash 指定初始落点（#/sessions、#/settings、#/guide 等） */
function openWorkbench(hash = ''): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('workbench.html') + hash })
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
    <header class="flex h-11 shrink-0 items-center gap-0.5 border-b border-border px-3">
      <div class="min-w-0 flex-1 truncate text-sm font-medium" :title="activeTitle">
        {{ activeTitle }}
      </div>

      <!-- 会话历史的入口在工作台：本面板不再承载会话列表（归属由标签页决定） -->
      <ui-tooltip-provider>
        <ui-tooltip>
          <ui-tooltip-trigger as-child>
            <ui-button
              variant="ghost"
              size="icon"
              class="size-7 shrink-0"
              aria-label="会话历史"
              @click="openWorkbench('#/sessions')"
            >
              <ui-history class="size-4" />
            </ui-button>
          </ui-tooltip-trigger>
          <ui-tooltip-content>会话历史</ui-tooltip-content>
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
  </div>
</template>
