<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import {
  ArrowLeft as UiArrowLeft,
  Plus as UiPlus,
  Search as UiSearch,
  Settings as UiSettings
} from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import SettingsPanel from '@/components/settings-panel.vue'
import ToolWorkspace from '@/components/tool-workspace.vue'

// 当前视图：工具多标签页（默认主页）/ 设置页
const view = ref<'tools' | 'settings'>('tools')

// 左侧导航栏「新建工具」：切回工具视图并调用工具工作台的创建逻辑
const workspaceRef = ref<InstanceType<typeof ToolWorkspace> | null>(null)

// 全局搜索：从主进程读取所有已落盘工具元信息，在顶栏搜索框中筛选并下拉列出
type ToolMeta = { id: string; name: string; title: string; description: string }
const allTools = ref<ToolMeta[]>([])
const searchQuery = ref('')
const searchFocused = ref(false)

const filteredTools = computed<ToolMeta[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return allTools.value
  return allTools.value.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q)
  )
})

onMounted(async () => {
  try {
    allTools.value = await window.api.tool.list()
  } catch (error) {
    console.error('加载工具列表失败', error)
  }
})

// 点击下拉项：切回工具视图并打开对应工具标签
function openTool(tool: ToolMeta): void {
  view.value = 'tools'
  workspaceRef.value?.openTool(tool)
  searchQuery.value = ''
  searchFocused.value = false
}

async function handleCreateTool(): Promise<void> {
  view.value = 'tools'
  await nextTick()
  workspaceRef.value?.createTool()
}
</script>

<template>
  <div class="workspace">
    <!-- 全宽顶栏：作为无边框窗口的拖拽区，含居中全局搜索框 -->
    <header class="workspace-topbar">
      <div class="no-drag relative mx-auto flex max-w-md flex-1 items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-sm text-muted-foreground">
        <ui-search class="size-4 shrink-0" />
        <input
          v-model="searchQuery"
          class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder="全局搜索：工具 / 任务 / 版本…"
          @focus="searchFocused = true"
          @blur="searchFocused = false"
          @keydown.esc="searchFocused = false"
        />
        <span class="rounded bg-card px-1 font-mono text-[10px]">⌘K</span>

        <ul
          v-if="searchFocused && filteredTools.length"
          class="tool-search-dropdown"
          role="listbox"
        >
          <li
            v-for="tool in filteredTools"
            :key="tool.id"
            class="tool-search-item"
            role="option"
            @mousedown.prevent="openTool(tool)"
          >
            <span class="truncate">{{ tool.title }}</span>
            <span class="tool-search-item__desc truncate">{{ tool.description }}</span>
          </li>
        </ul>
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
          :class="{ 'workspace-nav-item--active': view === 'settings' }"
          type="button"
          aria-label="设置"
          title="设置"
          @click="view = view === 'settings' ? 'tools' : 'settings'"
        >
          <ui-settings class="size-5" />
        </button>
      </aside>

      <section class="workspace-panel workspace-panel--grow" v-show="view === 'tools'">
        <tool-workspace ref="workspaceRef" @open-settings="view = 'settings'" />
      </section>

      <section class="workspace-panel workspace-panel--grow" v-show="view === 'settings'">
        <div class="flex h-full flex-col">
          <header class="flex h-11 shrink-0 items-center gap-2 border-b px-3">
            <ui-button
              variant="ghost"
              size="icon"
              class="no-drag size-8"
              aria-label="返回工具"
              title="返回工具"
              @click="view = 'tools'"
            >
              <ui-arrow-left class="size-4" />
            </ui-button>
            <h1 class="text-base font-semibold">设置</h1>
          </header>
          <div class="min-h-0 flex-1">
            <settings-panel />
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
