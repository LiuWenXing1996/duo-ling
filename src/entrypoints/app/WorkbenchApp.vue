<script setup lang="ts">
// 工作台标签页宿主。
//
// 产品形态（用户 2026-09-13 定）：side panel = 应用入口 = AI 对话；工具 / 设置 / 版本这些重界面
// 退到独立标签页 —— 本组件就是那个标签页。
//
// 结构平移自桌面版 app.vue 的「顶栏 + 左侧导航 + 工作区」三段，只裁掉两栏聊天
// （会话历史 | 当前会话已移入 side panel），保留的分支逐句照搬，未重写：
//   · 顶栏全局搜索：桌面版搜「工具 + 会话记录」，这里只搜工具（会话在侧边栏里搜）
//   · 左侧导航：置顶工具 / 新建工具 / 设置 / 开发者 / UI 测试
//   · 工作区：ToolWorkspace（多标签页：工具详情 / 代码 / 版本历史 / 数据 / 设置 …）
import { computed, onMounted, ref, watch } from 'vue'
import {
  Braces as UiBraces,
  FlaskConical as UiFlaskConical,
  MoreHorizontal as UiMoreHorizontal,
  Plus as UiPlus,
  Search as UiSearch,
  Settings as UiSettings,
  Terminal as UiTerminal,
} from '@lucide/vue'
import type { ToolOpenCommand } from '@/shared/types'
import {
  Combobox as UiCombobox,
  ComboboxAnchor as UiComboboxAnchor,
  ComboboxContent as UiComboboxContent,
  ComboboxInput as UiComboboxInput,
  ComboboxItem as UiComboboxItem,
} from '@/components/ui/combobox'
import {
  Popover as UiPopover,
  PopoverContent as UiPopoverContent,
  PopoverTrigger as UiPopoverTrigger,
} from '@/components/ui/popover'
import ToolWorkspace from '@/components/ToolWorkspace.vue'
import ToolIcon from '@/components/ToolIcon.vue'
import UserscriptManager from '@/components/userscript/UserscriptManager.vue'
import type { ToolMeta } from '@/types/tool'

// 左侧导航栏「新建工具」「设置」等：调用工具工作台的对应方法
const workspaceRef = ref<InstanceType<typeof ToolWorkspace> | null>(null)

// 用户脚本管理器：内嵌全屏面板（复用 workbench 单一 HTML 入口，规避多 HTML 入口在 rolldown-vite 下 plugin-vue compiler 未初始化）
const showUserscriptManager = ref(false)

// 全局搜索：工具在本地按标题/名称/描述子串过滤后直接打开
const allTools = ref<ToolMeta[]>([])
// 搜索框输入值：由 reka-ui ComboboxInput v-model 双向同步（选中后自动复位为空串）
const searchQuery = ref('')
// 当前选中的下拉项：带 `tool:` 前缀的值，处理完成后复位
const selectedId = ref<string | null>(null)
const searchOpen = ref(false)

const filteredTools = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return allTools.value
  return allTools.value.filter((t) =>
    [t.title, t.name, t.description].some((s) => s?.toLowerCase().includes(q))
  )
})

watch(selectedId, (id) => {
  if (!id) return
  if (id.startsWith('tool:')) {
    const tool = allTools.value.find((t) => t.id === id.slice(5))
    if (tool) workspaceRef.value?.openTool(tool)
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

// —— 工具置顶（用户独立配置）：左侧导航顶部置顶区 ——
const pinnedToolIds = ref<string[]>([])
// 侧边条直显上限，超出部分收进「更多」浮层
const PINNED_SIDEBAR_LIMIT = 8
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

onMounted(() => {
  void reloadTools()
  void loadPins()
  // Agent Loop 决定打开工具时（agent.tools.open），由主进程广播命令，此处切换/新建工具标签页。
  // 扩展版尚未平移 Agent，window.api.tool.onOpenCommand 目前返回空订阅 —— 调用点先留着。
  window.api.tool.onOpenCommand(openToolFromCommand)
})

function handleCreateTool(): void {
  workspaceRef.value?.createTool()
}

/** 切换用户脚本管理器面板（内嵌全屏覆盖层） */
function openUserscriptManager(): void {
  showUserscriptManager.value = true
}
</script>

<template>
  <div class="workspace">
    <!-- 顶栏：桌面版是无边框窗口拖拽区（-webkit-app-region: drag），浏览器标签页里该属性无副作用 -->
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
              placeholder="搜索工具…"
            />
          </ui-combobox-anchor>

          <ui-combobox-content>
            <div v-if="!filteredTools.length" class="px-2.5 py-1.5 text-sm text-muted-foreground">
              未找到匹配项
            </div>
            <template v-else>
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
          </ui-combobox-content>
        </ui-combobox>
      </div>
    </header>

    <!-- 顶栏之下：左侧图标导航栏 + 右侧工作区 -->
    <div class="workspace-main">
      <aside class="workspace-nav">
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
                  <tool-icon
                    :icon="tool.icon"
                    :fallback="tool.title"
                    class="size-4 shrink-0 leading-none"
                  />
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
        <button
          class="workspace-nav-item"
          type="button"
          aria-label="用户脚本"
          title="用户脚本管理器"
          @click="openUserscriptManager"
        >
          <ui-braces class="size-5" />
        </button>
      </aside>

      <section class="workspace-panel workspace-panel--grow">
        <!-- 多标签页：工具详情 / 代码 / 版本历史 / 数据详情 / 设置 / 开发者 -->
        <tool-workspace
          ref="workspaceRef"
          :tools="allTools"
          @tools-changed="reloadTools"
          @pins-changed="(ids: string[]) => (pinnedToolIds = ids)"
        />
      </section>
    </div>
  </div>

  <!-- 用户脚本管理器：内嵌全屏覆盖层（复用 workbench 单一 HTML 入口，规避多 HTML 入口在 rolldown-vite 下触发 plugin-vue compiler 未初始化） -->
  <Teleport to="body">
    <div
      v-if="showUserscriptManager"
      class="fixed inset-0 z-50 overflow-auto bg-zinc-50 dark:bg-zinc-900"
    >
      <button
        type="button"
        class="fixed right-4 top-4 z-20 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-600 shadow-sm hover:bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
        title="关闭管理器"
        @click="showUserscriptManager = false"
      >
        关闭 ✕
      </button>
      <UserscriptManager />
    </div>
  </Teleport>
</template>
