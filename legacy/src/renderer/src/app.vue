<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  FlaskConical as UiFlaskConical,
  MessageSquare as UiMessageSquare,
  MoreHorizontal as UiMoreHorizontal,
  Plus as UiPlus,
  Search as UiSearch,
  Settings as UiSettings,
  Terminal as UiTerminal
} from '@lucide/vue'
import type { ConversationSearchHit, ToolOpenCommand } from '../../shared/types'
import {
  Combobox as UiCombobox,
  ComboboxAnchor as UiComboboxAnchor,
  ComboboxContent as UiComboboxContent,
  ComboboxInput as UiComboboxInput,
  ComboboxItem as UiComboboxItem
} from '@/components/ui/combobox'
import {
  ResizableHandle as UiResizableHandle,
  ResizablePanel as UiResizablePanel,
  ResizablePanelGroup as UiResizablePanelGroup
} from '@/components/ui/resizable'
import {
  Popover as UiPopover,
  PopoverContent as UiPopoverContent,
  PopoverTrigger as UiPopoverTrigger
} from '@/components/ui/popover'
import ToolWorkspace from '@/components/ToolWorkspace.vue'
import ToolIcon from '@/components/ToolIcon.vue'
import SessionHistoryPanel from '@/components/SessionHistoryPanel.vue'
import ChatPanel from '@/components/ChatPanel.vue'
import {
  formatSessionTime,
  useGlobalConversation
} from '@/composables/use-global-conversation'
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
} = g

/** 删除会话：单个 / 全部（删除确认浮层在 session-history-panel 内自含） */
function onDeleteConversation(payload: { type: 'session' | 'all'; id?: string; title?: string }): void {
  if (payload.type === 'session' && payload.id) deleteConversation(payload.id)
  else deleteAllConversations()
}

/** 重命名会话：由 session-history-panel 的重命名弹窗触发 */
function onRenameConversation(payload: { id: string; title: string }): void {
  void renameConversation(payload.id, payload.title)
}

// 全局搜索：工具 + 会话记录双区下拉。
// reka-ui Combobox 关闭内建过滤（ignore-filter），由本组件统一过滤：
// 工具在本地按标题/名称/描述子串过滤；会话走主进程 conversation:search（标题+消息内容，带命中片段）。
const allTools = ref<ToolMeta[]>([])
// 搜索框输入值：由 reka-ui ComboboxInput v-model 双向同步（选中后自动复位为空串）
const searchQuery = ref('')
// 当前选中的下拉项：带前缀的值，tool:<id> 打开工具、conv:<id> 激活会话；处理完成后复位
const selectedId = ref<string | null>(null)
// 下拉框开关：控制 reka-ui Combobox 的 open。默认由 reka-ui（点击/聚焦/外部点击）驱动；
// 此处额外兜底处理「点击 Electron <webview>」这类跨文档区域——
// 其 pointerdown 不会冒泡到宿主 document，focusin 也不会冒泡，reka-ui 的外部关闭监听从收不到，
// 但输入框的 focusout 仍会冒泡到宿主 document，据此在焦点真正离开输入框时关闭。
const searchOpen = ref(false)

const SEARCH_INPUT_SELECTOR = 'input[role="combobox"]'

/**
 * 兜底关闭：当搜索输入框失焦且焦点没有回到输入框（如进入 webview、点击其它可聚焦元素）时，
 * 关闭全局搜索下拉框。等待一帧后再判定，避免点下拉项/键盘导航时因短暂失焦而误关。
 */
function onSearchFocusOut(event: FocusEvent): void {
  if (!searchOpen.value) return
  const target = event.target
  const input = document.querySelector<HTMLInputElement>(SEARCH_INPUT_SELECTOR)
  if (!(target instanceof Node) || !input) return
  if (target !== input && !input.contains(target)) return
  // 焦点移入下拉列表([role="listbox"])内（如点击选项时的 mousedown 瞬间）：
  // 此刻 click 尚未派发，若关闭下拉会把选项卸载导致 onSelect 收不到。交给选项自身的 click 去关闭。
  const related = event.relatedTarget
  if (related instanceof Element && related.closest('[role="listbox"]')) return
  setTimeout(() => {
    if (searchOpen.value && document.activeElement !== input) searchOpen.value = false
  }, 0)
}

// 自应用挂载后监听输入框 focusout；销毁时移除
function addSearchCloseGuard(): void {
  document.addEventListener('focusout', onSearchFocusOut, true)
}
function removeSearchCloseGuard(): void {
  document.removeEventListener('focusout', onSearchFocusOut, true)
}

const filteredTools = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return allTools.value
  return allTools.value.filter((t) =>
    [t.title, t.name, t.description].some((s) => s?.toLowerCase().includes(q))
  )
})

// 会话命中：空关键词为最近会话（本地已加载列表）；非空为防抖后的主进程搜索结果
const conversationHits = ref<ConversationSearchHit[]>([])
let searchTimer: ReturnType<typeof setTimeout> | null = null
let searchSeq = 0

async function runConversationSearch(query: string): Promise<void> {
  const seq = ++searchSeq
  try {
    const hits = await window.api.conversation.search(query)
    // 丢弃乱序/过期响应：仅当仍是本次查询时采纳
    if (seq === searchSeq && searchQuery.value.trim() === query) conversationHits.value = hits
  } catch (error) {
    console.error('搜索会话失败', error)
  }
}

watch(
  searchQuery,
  (query) => {
    if (searchTimer) clearTimeout(searchTimer)
    const q = query.trim()
    if (!q) {
      conversationHits.value = conversations.value
        .slice(0, 10)
        .map((c) => ({ conversation: c, snippet: '' }))
      return
    }
    searchTimer = setTimeout(() => void runConversationSearch(q), 200)
  },
  { immediate: true }
)

// 会话列表加载/增删后，若输入框为空则同步刷新「最近会话」
watch(conversations, () => {
  if (!searchQuery.value.trim()) {
    conversationHits.value = conversations.value
      .slice(0, 10)
      .map((c) => ({ conversation: c, snippet: '' }))
  }
})

watch(selectedId, (id) => {
  if (!id) return
  if (id.startsWith('tool:')) {
    const tool = allTools.value.find((t) => t.id === id.slice(5))
    if (tool) workspaceRef.value?.openTool(tool)
  } else if (id.startsWith('conv:')) {
    void activateConversation(id.slice(5))
  }
  selectedId.value = null
})

async function reloadTools(): Promise<void> {
  try {
    allTools.value = await window.api.tool.list()
  } catch (error) {
    console.error('加载工具列表失败', error)
  }
}

// —— 工具置顶（用户独立配置）：左侧边条顶部置顶区（主页「常用」分区由 ToolWorkspace 内部维护）——
const pinnedToolIds = ref<string[]>([])
// 侧边条直显上限，超出部分收进「更多」浮层
const PINNED_SIDEBAR_LIMIT = 8
// 置顶工具（保持置顶顺序，仅收录仍存在于工具列表中的）
const pinnedTools = computed<ToolMeta[]>(() =>
  pinnedToolIds.value
    .map((id) => allTools.value.find((t) => t.id === id))
    .filter((t): t is ToolMeta => Boolean(t))
)
const visiblePinnedTools = computed(() => pinnedTools.value.slice(0, PINNED_SIDEBAR_LIMIT))
const morePinnedTools = computed(() => pinnedTools.value.slice(PINNED_SIDEBAR_LIMIT))

async function loadPins(): Promise<void> {
  try {
    pinnedToolIds.value = await window.api.tool.pin.list()
  } catch (error) {
    console.error('加载工具置顶失败', error)
  }
}

/** 点击侧边条置顶图标：打开对应工具标签（已打开则激活） */
function openPinnedTool(tool: ToolMeta): void {
  workspaceRef.value?.openTool(tool)
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
  loadPins()
  // 首次进入：加载全局会话列表（有则激活第一个，无则新建）
  void loadConversations()
  // Agent Loop 决定打开工具时（agent.tools.open），由主进程广播命令，此处切换/新建工具标签页
  unsubscribeOpenCommand = window.api.tool.onOpenCommand(openToolFromCommand)
  // 兜底关闭：搜索下拉框处于打开态时，监听输入框 focusout 以处理 webview 等跨文档点击
  addSearchCloseGuard()
})

onUnmounted(() => {
  unsubscribeOpenCommand?.()
  removeSearchCloseGuard()
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
        <ui-combobox
          v-model="selectedId"
          v-model:open="searchOpen"
          class="flex-1"
          open-on-focus
          open-on-click
          ignore-filter
        >
          <ui-combobox-anchor
            class="flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-sm text-muted-foreground"
          >
            <ui-search class="size-4 shrink-0" />
            <ui-combobox-input
              v-model="searchQuery"
              :display-value="() => ''"
              class="min-w-0 flex-1"
              placeholder="全局搜索：工具 / 会话记录…"
            />
            <span class="rounded bg-card px-1 font-mono text-[10px]">⌘K</span>
          </ui-combobox-anchor>

          <ui-combobox-content>
            <div
              v-if="!filteredTools.length && !conversationHits.length"
              class="px-2.5 py-1.5 text-sm text-muted-foreground"
            >
              未找到匹配项
            </div>

            <template v-if="filteredTools.length">
              <div
                class="px-2.5 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                工具
              </div>
              <ui-combobox-item
                v-for="tool in filteredTools"
                :key="`tool:${tool.id}`"
                :text-value="`${tool.title} ${tool.name} ${tool.description}`"
                :value="`tool:${tool.id}`"
              >
                <div class="flex w-full min-w-0 items-start gap-2">
                  <tool-icon
                    :icon="tool.icon"
                    :fallback="tool.title"
                    class="mt-0.5 size-4 shrink-0 leading-none"
                  />
                  <div class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate">{{ tool.title }}</span>
                    <span class="truncate text-muted-foreground">{{ tool.description }}</span>
                  </div>
                </div>
              </ui-combobox-item>
            </template>

            <template v-if="conversationHits.length">
              <div
                class="px-2.5 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                会话
              </div>
              <ui-combobox-item
                v-for="hit in conversationHits"
                :key="`conv:${hit.conversation.id}`"
                :text-value="`${hit.conversation.title} ${hit.snippet}`"
                :value="`conv:${hit.conversation.id}`"
              >
                <div class="flex w-full min-w-0 items-start gap-2">
                  <ui-message-square
                    class="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                  <div class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate">{{ hit.conversation.title }}</span>
                    <span class="truncate text-muted-foreground">
                      {{ hit.snippet || formatSessionTime(hit.conversation.lastMessageAt) }}
                    </span>
                  </div>
                </div>
              </ui-combobox-item>
            </template>
          </ui-combobox-content>
        </ui-combobox>
      </div>
    </header>

    <!-- 顶栏之下：左侧图标导航栏 + 右侧内容区 -->
    <div class="workspace-main">
      <aside class="workspace-nav">
        <!-- 置顶工具区：置顶工具图标竖排一键直达；超过直显上限收进「更多」浮层 -->
        <div v-if="pinnedTools.length" class="workspace-nav-pins">
          <button
            v-for="tool in visiblePinnedTools"
            :key="tool.id"
            class="workspace-nav-item"
            type="button"
            :aria-label="tool.title"
            :title="tool.title"
            @click="openPinnedTool(tool)"
          >
            <tool-icon :icon="tool.icon" :fallback="tool.title" class="text-sm leading-none" />
          </button>
          <ui-popover v-if="morePinnedTools.length">
            <ui-popover-trigger as-child>
              <button
                class="workspace-nav-item"
                type="button"
                aria-label="更多置顶工具"
                title="更多置顶工具"
              >
                <ui-more-horizontal class="size-5" />
              </button>
            </ui-popover-trigger>
            <ui-popover-content class="w-56 p-1.5" align="start" side="right">
              <div class="flex flex-col gap-0.5">
                <button
                  v-for="tool in morePinnedTools"
                  :key="tool.id"
                  type="button"
                  class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
                  @click="openPinnedTool(tool)"
                >
                  <tool-icon :icon="tool.icon" :fallback="tool.title" class="size-4 shrink-0 leading-none" />
                  <span class="truncate">{{ tool.title }}</span>
                </button>
              </div>
            </ui-popover-content>
          </ui-popover>
          <div class="workspace-nav-pins__divider" />
        </div>
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
        <button
          class="workspace-nav-item"
          type="button"
          aria-label="开发者"
          title="开发者"
          @click="workspaceRef?.openDeveloperTab()"
        >
          <ui-terminal class="size-5" />
        </button>
        <button
          class="workspace-nav-item"
          type="button"
          aria-label="UI 测试"
          title="UI 测试"
          @click="workspaceRef?.openUiTestTab()"
        >
          <ui-flask-conical class="size-5" />
        </button>
      </aside>

      <section class="workspace-panel workspace-panel--grow">
        <!-- 全局三栏：会话历史 | 当前会话 | 多标签页（工具详情 / 设置 / 版本历史） -->
        <ui-resizable-panel-group
          direction="horizontal"
          class="global-layout flex h-full w-full min-w-0"
        >
          <!-- 会话历史：全局会话列表（主进程 conversation-store） -->
          <ui-resizable-panel :default-size="20" :min-size="12" :max-size="36" class="min-w-0">
            <session-history-panel
              :conversations="conversations"
              :active-conversation-id="activeConversationId"
              @activate="activateConversation"
              @new="newConversation"
              @delete="onDeleteConversation"
              @rename="onRenameConversation"
            />
          </ui-resizable-panel>

          <ui-resizable-handle aria-label="拖拽调整会话历史宽度" />

          <!-- 当前会话：全局当前激活会话的聊天窗 -->
          <ui-resizable-panel :default-size="30" :min-size="16" :max-size="40" class="min-w-0">
            <chat-panel
              :messages="messages"
              :pending-map="pendingMap"
              :usage-by-message-id="usageByMessageId"
              :streaming="streaming"
              @send="send"
              @stop="stopGeneration"
              @open-settings="workspaceRef?.openSettingsTab()"
            />
          </ui-resizable-panel>

          <ui-resizable-handle aria-label="拖拽调整当前会话宽度" />

          <!-- 多标签页：工具详情 / 设置 / 版本历史 / 数据详情 -->
          <ui-resizable-panel :default-size="50" :min-size="24" class="min-w-0">
            <tool-workspace
              ref="workspaceRef"
              :tools="allTools"
              @tools-changed="reloadTools"
              @pins-changed="(ids: string[]) => (pinnedToolIds = ids)"
            />
          </ui-resizable-panel>
        </ui-resizable-panel-group>
      </section>
    </div>
  </div>
</template>
