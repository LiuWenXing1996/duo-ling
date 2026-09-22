<script setup lang="ts">
// 对话界面宿主：网页浮层（floatpanel.html，由 content script 注入的 iframe）的根组件。
//
// 布局：顶栏 = 当前会话标题 + 两个去处（会话历史 / 工作台）+ 收起按钮；下方是消息区与输入区。
//
// **收起**（顶栏最右）：把对话框从页面上收掉，动作落在父页的内容脚本上（见 collapse）。
// 再打开要从工具栏 popup 或页面右键菜单 —— 对话框平时不在页面里（见 content.ts）。
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
  Minus as UiMinus,
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
import { readPinnedTabId } from '@/lib/owning-tab'
import { FLOAT_COLLAPSE_REQUEST } from '@/shared/extension-ipc'

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

/**
 * 收起对话框（顶栏最右那颗按钮）。
 *
 * 容器的显隐握在父页的内容脚本手里，而本组件在 iframe 里（跨源），只能发一条定向消息叫它收 ——
 * tabId 从 iframe URL 的 `?tab=` 读出（见 lib/owning-tab）。
 *
 * 发不出去时静默（页面已导航走 / 扩展刚更新）：这颗按钮的用途只是「让开页面」，没什么可失败的。
 */
function collapse(): void {
  const tabId = readPinnedTabId()
  if (tabId == null) return
  chrome.tabs.sendMessage(tabId, FLOAT_COLLAPSE_REQUEST).catch(() => {})
}

onMounted(() => {
  void loadConversations()
})
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

      <!-- 收起对话框：再打开要从工具栏 popup 或页面右键菜单（对话框平时不在页面里） -->
      <ui-tooltip-provider>
        <ui-tooltip>
          <ui-tooltip-trigger as-child>
            <ui-button
              variant="ghost"
              size="icon"
              class="size-7 shrink-0"
              aria-label="收起"
              @click="collapse"
            >
              <ui-minus class="size-4" />
            </ui-button>
          </ui-tooltip-trigger>
          <ui-tooltip-content>收起</ui-tooltip-content>
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
