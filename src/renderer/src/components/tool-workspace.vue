<script setup lang="ts">
import { computed, ref } from 'vue'
import ToolPage, { type ToolPageMeta } from '@/components/tool-page.vue'
import { Sparkles as UiSparkles, X as UiX } from '@lucide/vue'

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

// 供根布局全宽顶栏搜索下拉点击打开：若该工具已打开则激活，否则新开标签
type ToolMeta = { id: string; name: string; title: string; description: string }
function openTool(tool: ToolMeta): void {
  if (!openTabs.value.some((t) => t.id === tool.id)) {
    openTabs.value.push({ id: tool.id, title: tool.title })
  }
  activate(tool.id)
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

// 暴露给根布局：左侧导航栏「新建工具」、全宽顶栏搜索下拉「打开工具」
defineExpose({ createTool, openTool })
</script>

<template>
  <div class="tool-workspace">
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
      <!-- 空工作台：提示用户通过左侧导航栏「新建工具」创建 -->
      <div v-else class="tool-empty">
        <p>{{ toolError || '还没有工具，点击左侧「新建工具」创建' }}</p>
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
