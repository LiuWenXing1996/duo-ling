<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { Plus as UiPlus, Search as UiSearch, Settings as UiSettings } from '@lucide/vue'
import type { ToolOpenCommand } from '../../shared/types'
import {
  Combobox as UiCombobox,
  ComboboxAnchor as UiComboboxAnchor,
  ComboboxContent as UiComboboxContent,
  ComboboxEmpty as UiComboboxEmpty,
  ComboboxInput as UiComboboxInput,
  ComboboxItem as UiComboboxItem
} from '@/components/ui/combobox'
import {
  ResizableHandle as UiResizableHandle,
  ResizablePanel as UiResizablePanel,
  ResizablePanelGroup as UiResizablePanelGroup
} from '@/components/ui/resizable'
import ToolWorkspace from '@/components/ToolWorkspace.vue'
import ToolIcon from '@/components/ToolIcon.vue'
import SessionHistoryPanel from '@/components/SessionHistoryPanel.vue'
import ChatPanel from '@/components/ChatPanel.vue'
import { useGlobalConversation } from '@/composables/use-global-conversation'
import type { ToolMeta } from '@/types/tool'

// 左侧导航栏「新建工具」「设置」：调用工具工作台的对应方法
const workspaceRef = ref<InstanceType<typeof ToolWorkspace> | null>(null)

// —— 全局会话（主进程 conversation-store 一等公民）：会话历史 / 当前会话 + 工具多标签三栏组合 ——
const g = useGlobalConversation({
  // 多工具意图应用成功后：刷新对应工具详情并同步标签标题
  onToolApplied: (results) => {
    for (const r of results) {
      if (!r.ok) continue
      workspaceRef.value?.reloadTool(r.toolId)
      if (r.title) workspaceRef.value?.renameTool(r.toolId, r.title)
    }
  }
})
const {
  conversations,
  activeConversationId,
  messages,
  pendingMap,
  streaming,
  draft,
  loadConversations,
  newConversation,
  activateConversation,
  deleteConversation,
  deleteAllConversations,
  send,
  stopGeneration
} = g

/** 删除会话：单个 / 全部（删除确认浮层在 session-history-panel 内自含） */
function onDeleteConversation(payload: { type: 'session' | 'all'; id?: string; title?: string }): void {
  if (payload.type === 'session' && payload.id) deleteConversation(payload.id)
  else deleteAllConversations()
}

// 全局搜索：从主进程读取所有已落盘工具元信息，在顶栏搜索框中筛选并下拉列出
const allTools = ref<ToolMeta[]>([])
// 当前选中的 tool.id：由 reka-ui Combobox 在选中下拉项时写入，触发打开工具后复位
const selectedToolId = ref<string | null>(null)

// reka-ui Combobox 内建了基于 textValue 的子串过滤，因此无需再手写 filteredTools
watch(selectedToolId, (id) => {
  if (!id) return
  const tool = allTools.value.find((t) => t.id === id)
  if (tool) workspaceRef.value?.openTool(tool)
  selectedToolId.value = null
})

async function reloadTools(): Promise<void> {
  try {
    allTools.value = await window.api.tool.list()
  } catch (error) {
    console.error('加载工具列表失败', error)
  }
}

function openToolFromCommand(cmd: ToolOpenCommand): void {
  let tool = allTools.value.find((t) => t.id === cmd.toolId)
  if (!tool) {
    // 工具列表尚未刷新到该工具：用命令里的最小信息补占位元信息，仍能打开
    tool = { id: cmd.toolId, name: cmd.toolId, title: cmd.title, description: '', icon: undefined }
  }
  workspaceRef.value?.openTool(tool)
}

let unsubscribeOpenCommand: (() => void) | null = null

onMounted(() => {
  reloadTools()
  // 首次进入：加载全局会话列表（有则激活第一个，无则新建）
  void loadConversations()
  // Agent Loop 决定打开工具时（agent.tools.open），由主进程广播命令，此处切换/新建工具标签页
  unsubscribeOpenCommand = window.api.tool.onOpenCommand(openToolFromCommand)
})

onUnmounted(() => {
  unsubscribeOpenCommand?.()
})

function handleCreateTool(): void {
  workspaceRef.value?.createTool()
}
</script>

<template>
  <div class="workspace">
    <!-- 全宽顶栏：作为无边框窗口的拖拽区，含居中全局搜索框 -->
    <header class="workspace-topbar">
      <div class="no-drag relative mx-auto flex w-full max-w-md flex-1">
        <ui-combobox v-model="selectedToolId" class="flex-1" open-on-focus open-on-click>
          <ui-combobox-anchor
            class="flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-sm text-muted-foreground"
          >
            <ui-search class="size-4 shrink-0" />
            <ui-combobox-input
              :display-value="() => ''"
              class="min-w-0 flex-1"
              placeholder="全局搜索：工具 / 任务 / 版本…"
            />
            <span class="rounded bg-card px-1 font-mono text-[10px]">⌘K</span>
          </ui-combobox-anchor>

          <ui-combobox-content>
            <ui-combobox-empty>未找到匹配工具</ui-combobox-empty>
            <ui-combobox-item
              v-for="tool in allTools"
              :key="tool.id"
              :text-value="`${tool.title} ${tool.name} ${tool.description}`"
              :value="tool.id"
            >
              <tool-icon :icon="tool.icon" :fallback="tool.title" class="shrink-0 text-sm" />
              <span class="truncate">{{ tool.title }}</span>
              <span class="truncate text-muted-foreground">{{ tool.description }}</span>
            </ui-combobox-item>
          </ui-combobox-content>
        </ui-combobox>
      </div>
    </header>

    <!-- 顶栏之下：左侧图标导航栏 + 右侧内容区 -->
    <div class="workspace-main">
      <aside class="workspace-nav">
        <button
          class="workspace-nav-item"
          type="button"
          aria-label="新建工具"
          title="新建工具"
          @click="handleCreateTool"
        >
          <ui-plus class="size-5" />
        </button>
        <button
          class="workspace-nav-item"
          type="button"
          aria-label="设置"
          title="设置"
          @click="workspaceRef?.openSettingsTab()"
        >
          <ui-settings class="size-5" />
        </button>
      </aside>

      <section class="workspace-panel workspace-panel--grow">
        <!-- 全局三栏：会话历史 | 当前会话 | 多标签页（工具详情 / 设置 / 版本历史） -->
        <ui-resizable-panel-group
          direction="horizontal"
          class="global-layout flex h-full w-full min-w-0"
        >
          <!-- 会话历史：全局会话列表（主进程 conversation-store） -->
          <ui-resizable-panel :default-size="18" :min-size="12" :max-size="36" class="min-w-0">
            <session-history-panel
              :conversations="conversations"
              :active-conversation-id="activeConversationId"
              @activate="activateConversation"
              @new="newConversation"
              @delete="onDeleteConversation"
            />
          </ui-resizable-panel>

          <ui-resizable-handle aria-label="拖拽调整会话历史宽度" />

          <!-- 当前会话：全局当前激活会话的聊天窗 -->
          <ui-resizable-panel :default-size="26" :min-size="16" :max-size="40" class="min-w-0">
            <chat-panel
              :messages="messages"
              :pending-map="pendingMap"
              :streaming="streaming"
              :draft="draft"
              @send="send"
              @stop="stopGeneration"
              @open-settings="workspaceRef?.openSettingsTab()"
            />
          </ui-resizable-panel>

          <ui-resizable-handle aria-label="拖拽调整当前会话宽度" />

          <!-- 多标签页：工具详情 / 设置 / 版本历史 / 数据详情 -->
          <ui-resizable-panel :default-size="56" :min-size="24" class="min-w-0">
            <tool-workspace ref="workspaceRef" :tools="allTools" @tools-changed="reloadTools" />
          </ui-resizable-panel>
        </ui-resizable-panel-group>
      </section>
    </div>
  </div>
</template>
