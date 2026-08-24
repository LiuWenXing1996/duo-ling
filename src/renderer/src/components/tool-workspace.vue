<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PropType } from 'vue'
import SettingsPanel from '@/components/settings-panel.vue'
import ToolPage, { type ToolPageMeta } from '@/components/tool-page.vue'
import ToolHistory from '@/components/tool-history.vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  Dialog as UiDialog,
  DialogContent as UiDialogContent,
  DialogDescription as UiDialogDescription,
  DialogFooter as UiDialogFooter,
  DialogTitle as UiDialogTitle
} from '@/components/ui/dialog'
import { GitBranch as UiGitBranch, Home as UiHome, Plus as UiPlus, Settings as UiSettings, Sparkles as UiSparkles, Trash2 as UiTrash, X as UiX } from '@lucide/vue'

// 打开的工作区标签：主页 / 工具 / 设置 / 工具版本历史
type OpenTool = {
  /** 标签唯一标识：主页与设置固定，工具用工具 ID，版本历史用「工具ID:history」 */
  id: string
  title: string
  /** 标签种类：home 渲染工具主页，tool 渲染三栏工具页，settings 渲染设置面板，history 渲染版本历史 */
  kind: 'home' | 'tool' | 'settings' | 'tool-history'
  /** 仅 tool-history：对应的工具 ID 与标题（用于加载并展示该工具的 git 历史） */
  toolId?: string
  toolTitle?: string
}

// 工具元信息（来自主进程 tool.list）：主页网格与全局搜索共用
type ToolMeta = { id: string; name: string; title: string; description: string }
const props = defineProps({
  tools: { type: Array as PropType<ToolMeta[]>, default: () => [] }
})
const emit = defineEmits<{ toolsChanged: [] }>()

// 主页标签：始终存在且不可关闭，作为默认视图
const HOME_TAB: OpenTool = { kind: 'home', id: 'home', title: '主页' }
const openTabs = ref<OpenTool[]>([HOME_TAB])
const activeTabId = ref('')

const activeTab = computed<OpenTool | undefined>(
  () => openTabs.value.find((t) => t.id === activeTabId.value) ?? openTabs.value[0]
)

// 当前激活标签是否为设置标签
const activeIsSettings = computed(() => activeTab.value?.kind === 'settings')

// 当前激活工具的三栏页元信息（会话历史 / 当前会话 / 工具详情）
const activeToolMeta = computed<ToolPageMeta | undefined>(() => {
  const tab = activeTab.value
  if (!tab || tab.kind !== 'tool') return undefined
  return { id: tab.id, title: tab.title }
})

function activate(id: string): void {
  activeTabId.value = id
}

function closeTab(id: string): void {
  // 主页标签始终保留，不可关闭
  if (id === HOME_TAB.id) return
  const idx = openTabs.value.findIndex((t) => t.id === id)
  if (idx === -1) return
  openTabs.value = openTabs.value.filter((t) => t.id !== id)
  if (activeTabId.value === id) {
    const next = openTabs.value[Math.max(0, idx - 1)] ?? openTabs.value[0]
    activeTabId.value = next?.id ?? ''
  }
}

// 供根布局搜索结果与主页网格点击打开：若该工具已打开则激活，否则新开标签
function openTool(tool: ToolMeta): void {
  if (!openTabs.value.some((t) => t.id === tool.id)) {
    openTabs.value.push({ kind: 'tool', id: tool.id, title: tool.title })
  }
  activate(tool.id)
}

// 打开设置标签页：若已打开则激活，否则新开一个
function openSettingsTab(): void {
  if (!openTabs.value.some((t) => t.kind === 'settings')) {
    openTabs.value.push({ kind: 'settings', id: 'settings', title: '设置' })
  }
  activate('settings')
}

// 打开某工具的「版本历史」标签页：同一工具只有一个历史页，已打开则激活
function openToolHistory(tool: ToolPageMeta): void {
  const id = `${tool.id}:history`
  if (!openTabs.value.some((t) => t.id === id)) {
    openTabs.value.push({
      kind: 'tool-history',
      id,
      title: `${tool.title} · 历史`,
      toolId: tool.id,
      toolTitle: tool.title
    })
  }
  activate(id)
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
  const tab: OpenTool = { kind: 'tool', id: res.id, title: res.title ?? '新建工具' }
  openTabs.value.push(tab)
  activate(tab.id)
  // 通知根布局刷新工具列表（主页网格 / 全局搜索）
  emit('toolsChanged')
}

// 删除确认弹窗：当前待删除的工具（null 表示未打开弹窗）
const deleteTarget = ref<ToolMeta | null>(null)
const deleteDialogOpen = computed({
  get: () => !!deleteTarget.value,
  set: (open: boolean) => {
    if (!open) deleteTarget.value = null
  }
})

// 点击卡片删除按钮：仅打开确认弹窗，不立即删除
function askDeleteTool(tool: ToolMeta): void {
  deleteTarget.value = tool
}

// 用户在弹窗中确认删除：移除其落盘目录；若该工具标签已打开则一并关闭，随后刷新工具列表。
async function confirmDeleteTool(): Promise<void> {
  const tool = deleteTarget.value
  if (!tool) return
  deleteTarget.value = null
  toolError.value = ''
  const res = await window.api.tool.delete(tool.id)
  if (!res.ok) {
    toolError.value = res.error ?? '删除工具失败'
    return
  }
  closeTab(tool.id)
  emit('toolsChanged')
}

// 暴露给根布局：左侧导航栏「新建工具」「设置」、全宽顶栏搜索下拉「打开工具」
defineExpose({ createTool, openTool, openSettingsTab })
</script>

<template>
  <div class="tool-workspace">
    <!-- 标签栏：主页 / 已打开工具 / 设置 -->
    <nav v-if="openTabs.length" class="tool-tabbar" aria-label="工作区标签">
      <div
        v-for="tab in openTabs"
        :key="tab.id"
        class="tool-tab"
        :class="{ 'tool-tab--active': tab.id === activeTabId }"
        role="tab"
        :aria-selected="tab.id === activeTabId"
        @click="activate(tab.id)"
      >
        <ui-home v-if="tab.kind === 'home'" class="size-3.5 shrink-0" :class="tab.id === activeTabId ? 'text-primary' : ''" />
        <ui-sparkles v-else-if="tab.kind === 'tool'" class="size-3.5 shrink-0" :class="tab.id === activeTabId ? 'text-primary' : ''" />
        <ui-git-branch v-else-if="tab.kind === 'tool-history'" class="size-3.5 shrink-0" :class="tab.id === activeTabId ? 'text-primary' : ''" />
        <ui-settings v-else class="size-3.5 shrink-0" :class="tab.id === activeTabId ? 'text-primary' : ''" />
        <span class="truncate">{{ tab.title }}</span>
        <button
          v-if="tab.kind !== 'home'"
          class="no-drag ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          type="button"
          aria-label="关闭标签"
          @click.stop="closeTab(tab.id)"
        >
          <ui-x class="size-3" />
        </button>
      </div>
    </nav>

    <div class="min-h-0 flex-1 relative">
      <!-- 主页：所有工具网格 + 新增工具 -->
      <div v-if="activeTab?.kind === 'home'" class="home-panel">
        <header class="home-panel__header">
          <h1 class="text-base font-semibold">主页</h1>
          <button class="home-panel__new no-drag" type="button" @click="createTool">
            <ui-plus class="size-4" />
            <span>新增工具</span>
          </button>
        </header>
        <p v-if="toolError" class="home-panel__error">{{ toolError }}</p>
        <div class="home-panel__body">
          <div
            v-for="tool in props.tools"
            :key="tool.id"
            class="tool-card"
            role="button"
            tabindex="0"
            @click="openTool(tool)"
            @keydown.enter="openTool(tool)"
          >
            <button
              class="tool-card__delete no-drag"
              type="button"
              aria-label="删除工具"
              title="删除工具"
              @click.stop="askDeleteTool(tool)"
            >
              <ui-trash class="size-3.5" />
            </button>
            <span class="tool-card__icon">
              <ui-sparkles class="size-4" />
            </span>
            <span class="tool-card__title">{{ tool.title }}</span>
            <span class="tool-card__desc">{{ tool.description }}</span>
          </div>
          <p v-if="!props.tools.length" class="home-panel__empty">还没有工具，点击右上角「新增工具」创建</p>
        </div>
      </div>
      <!-- 工具页：三栏（会话历史 / 当前会话 / 工具详情） -->
      <tool-page
        v-else-if="activeToolMeta"
        :key="activeToolMeta.id"
        :tool="activeToolMeta"
        @renamed="renameTab"
        @open-settings="openSettingsTab"
        @open-history="openToolHistory"
      />
      <!-- 工具版本历史：展示该工具的 git 提交记录 -->
      <tool-history
        v-else-if="activeTab?.kind === 'tool-history'"
        :tool-id="activeTab.toolId ?? ''"
        :tool-title="activeTab.toolTitle ?? activeTab.title"
      />
      <!-- 设置标签：渲染设置面板 -->
      <settings-panel v-else-if="activeIsSettings" />
    </div>

    <!-- 删除工具确认弹窗：使用 UI 弹窗而非原生 confirm -->
    <ui-dialog v-model:open="deleteDialogOpen">
      <ui-dialog-content class="max-w-md">
        <ui-dialog-title class="text-base font-semibold">删除工具</ui-dialog-title>
        <ui-dialog-description class="text-sm text-muted-foreground">
          确定删除工具「{{ deleteTarget?.title }}」吗？删除后不可恢复。
        </ui-dialog-description>
        <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
          <ui-button variant="ghost" size="sm" @click="deleteTarget = null">
            取消
          </ui-button>
          <ui-button variant="destructive" size="sm" @click="confirmDeleteTool">
            删除
          </ui-button>
        </ui-dialog-footer>
      </ui-dialog-content>
    </ui-dialog>
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

// 主页：所有工具网格 + 新增工具
.home-panel {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;

  &__header {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 48px;
    padding: 0 16px;
    border-bottom: 1px solid var(--border);
  }

  &__new {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 12px;
    font-size: 12.5px;
    color: var(--primary-foreground);
    background: var(--primary);
    border-radius: 6px;
    transition: opacity 0.15s;

    &:hover {
      opacity: 0.88;
    }
  }

  &__error {
    flex: none;
    margin: 0;
    padding: 8px 16px 0;
    color: var(--destructive);
    font-size: 12.5px;
  }

  &__body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 12px;
    align-content: start;
    padding: 16px;
  }

  &__empty {
    grid-column: 1 / -1;
    margin: 0;
    color: var(--muted-foreground);
    font-size: 13px;
    text-align: center;
    padding-top: 48px;
  }
}

// 工具卡片：点击打开对应工具标签
.tool-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px;
  text-align: left;
  cursor: pointer;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  transition: border-color 0.15s, background-color 0.15s;

  &:hover {
    border-color: var(--primary);
    background: var(--muted);

    .tool-card__delete {
      opacity: 1;
    }
  }

  &:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }

  &__delete {
    position: absolute;
    top: 8px;
    right: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    color: var(--muted-foreground);
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 6px;
    opacity: 0;
    transition: opacity 0.15s, color 0.15s, border-color 0.15s;

    &:hover {
      color: var(--destructive);
      border-color: var(--destructive);
    }
  }

  &__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin-bottom: 4px;
    color: var(--primary);
    background: var(--muted);
    border-radius: 6px;
  }

  &__title {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--foreground);
  }

  &__desc {
    font-size: 12px;
    color: var(--muted-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
