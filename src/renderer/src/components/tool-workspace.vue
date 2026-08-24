<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Button as UiButton } from '@/components/ui/button'
import ToolPage, { type ToolPageMeta } from '@/components/tool-page.vue'
import {
  Gem as UiGem,
  Plus as UiPlus,
  Search as UiSearch,
  Settings as UiSettings,
  Sparkles as UiSparkles,
  X as UiX
} from '@lucide/vue'

// 打开的工具标签：每个标签对应一个「新建工具」创建的、落盘在工具根目录下的真实工具
type OpenTool = {
  /** 工具唯一 ID（tool:// host 与工具文件夹名） */
  id: string
  title: string
}
const openTabs = ref<OpenTool[]>([])
const activeTabId = ref('')

const activeTab = computed<OpenTool | undefined>(
  () => openTabs.value.find((t) => t.id === activeTabId.value) ?? openTabs.value[0]
)

// 当前激活工具的三栏页元信息（会话历史 / 当前会话 / 工具详情）
const activeToolMeta = computed<ToolPageMeta | undefined>(() =>
  activeTab.value ? { id: activeTab.value.id, title: activeTab.value.title } : undefined
)

const emit = defineEmits<{ openSettings: [] }>()

function activate(id: string): void {
  activeTabId.value = id
}

function closeTab(id: string): void {
  const idx = openTabs.value.findIndex((t) => t.id === id)
  if (idx === -1) return
  openTabs.value = openTabs.value.filter((t) => t.id !== id)
  if (activeTabId.value === id) {
    const next = openTabs.value[Math.max(0, idx - 1)] ?? openTabs.value[0]
    activeTabId.value = next?.id ?? ''
  }
}

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

// 点击下拉项：若该工具已打开则激活，否则新开标签
function openTool(tool: ToolMeta): void {
  if (!openTabs.value.some((t) => t.id === tool.id)) {
    openTabs.value.push({ id: tool.id, title: tool.title })
  }
  activate(tool.id)
  searchQuery.value = ''
  searchFocused.value = false
}

// 工具页内生成器重写 index.html + meta.json 后，同步更新标签标题
function renameTab(id: string, title: string): void {
  const tab = openTabs.value.find((t) => t.id === id)
  if (tab) tab.title = title
}

const toolError = ref('')

// 点击「新建工具」：由主进程立即创建一个工具文件夹（index.html + meta.json），
// 随后在本工作台打开该工具的标签页（三栏工具页由激活标签驱动）。
async function createTool(): Promise<void> {
  toolError.value = ''
  const res = await window.api.tool.create()
  if (!res.ok || !res.id) {
    toolError.value = res.error ?? '新建工具失败'
    return
  }
  const tab: OpenTool = { id: res.id, title: res.title ?? '新建工具' }
  openTabs.value.push(tab)
  activate(tab.id)
}
</script>

<template>
  <div class="tool-workspace">
    <!-- 顶栏：作为无边框窗口的拖拽区，可交互元素需 no-drag -->
    <header class="tool-topbar">
      <div class="flex items-baseline gap-2">
        <span class="flex items-center gap-1.5 text-base font-semibold">
          <ui-gem class="size-4 text-primary" />
          小班
        </span>
        <span class="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          DUO-LING / TOOL-BENCH
        </span>
      </div>

      <div class="no-drag relative flex max-w-md flex-1 items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-muted-foreground">
        <ui-search class="size-4 shrink-0" />
        <input
          v-model="searchQuery"
          class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder="全局搜索：工具 / 任务 / 版本…"
          @focus="searchFocused = true"
          @blur="searchFocused = false"
          @keydown.esc="searchFocused = false"
        />
        <span class="rounded border border-border bg-muted px-1 font-mono text-[10px]">⌘K</span>

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
            :data-selected="openTabs.some((t) => t.id === tool.id)"
            @mousedown.prevent="openTool(tool)"
          >
            <span class="truncate">{{ tool.title }}</span>
            <span class="tool-search-item__desc truncate">{{ tool.description }}</span>
          </li>
        </ul>
      </div>

      <div class="no-drag ml-auto flex items-center gap-2">
        <ui-button size="sm" class="no-drag" @click="createTool">
          <ui-plus class="size-4" />新建工具
        </ui-button>
        <ui-button variant="ghost" size="icon" class="no-drag" aria-label="设置" @click="emit('openSettings')">
          <ui-settings class="size-4" />
        </ui-button>
      </div>
    </header>

    <!-- 标签栏：每个已创建的工具一个标签 -->
    <nav v-if="openTabs.length" class="tool-tabbar" aria-label="工具标签">
      <div
        v-for="tab in openTabs"
        :key="tab.id"
        class="tool-tab"
        :class="{ 'tool-tab--active': tab.id === activeTabId }"
        role="tab"
        :aria-selected="tab.id === activeTabId"
        @click="activate(tab.id)"
      >
        <ui-sparkles class="size-3.5 shrink-0" :class="tab.id === activeTabId ? 'text-primary' : ''" />
        <span class="truncate">{{ tab.title }}</span>
        <button
          class="no-drag ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          type="button"
          aria-label="关闭标签"
          @click.stop="closeTab(tab.id)"
        >
          <ui-x class="size-3" />
        </button>
      </div>
    </nav>

    <!-- 当前工具页：三栏（会话历史 / 当前会话 / 工具详情） -->
    <div class="min-h-0 flex-1 relative">
      <tool-page
        v-if="activeToolMeta"
        :key="activeToolMeta.id"
        :tool="activeToolMeta"
        @renamed="renameTab"
        @open-settings="emit('openSettings')"
      />
      <!-- 空工作台：提示用户通过「新建工具」创建 -->
      <div v-else class="tool-empty">
        <p>{{ toolError || '还没有工具，点击右上角「新建工具」创建' }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
.tool-workspace {
  display: flex;
  flex-direction: column;
  // 作为 .workspace-panel--grow（flex 行容器）的 item，必须 grow 才能填满宽度，
  // 否则宽度会跟随内容：内容变窄时（如 Markdown 页）右侧留白
  flex: 1;
  min-width: 0;
  height: 100%;
  min-height: 0;
  background: var(--background);
}

// 空工作台：提示用户通过「新建工具」创建（覆盖在工具页容器之上）
.tool-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground);
  font-size: 13px;
}

.tool-topbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  height: 46px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
  user-select: none;
}

// 全局搜索下拉：定位于搜索框之下，宽度与搜索框一致
.tool-search-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 50;
  max-height: 320px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--popover);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.16);
}

.tool-search-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12.5px;
  color: var(--foreground);
  cursor: pointer;

  &:hover {
    background: var(--muted);
  }

  &__desc {
    flex: 1;
    font-size: 11px;
    color: var(--muted-foreground);
  }
}

.tool-tabbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 40px;
  padding: 0 8px;
  overflow-x: auto;
  border-bottom: 1px solid var(--border);
  background: var(--muted);
}

.tool-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  height: 100%;
  padding: 0 10px 0 12px;
  font-size: 12.5px;
  color: var(--muted-foreground);
  border-right: 1px solid var(--border);
  transition: background-color 0.15s, color 0.15s;

  &--active {
    color: var(--foreground);
    background: var(--card);
  }

  &:hover {
    color: var(--foreground);
  }
}
</style>
