<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { PropType } from 'vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import ToolDetailPanel from '@/components/ToolDetailPanel.vue'
import ToolHistory from '@/components/ToolHistory.vue'
import ToolArchivePanel from '@/components/ToolArchivePanel.vue'
import ToolCodeBrowser from '@/components/ToolCodeBrowser.vue'
import ToolDataDetail from '@/components/ToolDataDetail.vue'
import DeveloperPanel from '@/components/DeveloperPanel.vue'
import UiTestPanel from '@/components/UiTestPanel.vue'
import HomePanel from '@/components/HomePanel.vue'
import WorkspaceTabs from '@/components/WorkspaceTabs.vue'
import ToolEditDialog from '@/components/ToolEditDialog.vue'
import ToolDeleteDialog from '@/components/ToolDeleteDialog.vue'
import type { OpenTool, ToolDetailMeta } from '@/types/tab'
import type { ToolMeta } from '@/types/tool'
import {
  Tabs as UiTabs,
  TabsContent as UiTabsContent
} from '@/components/ui/tabs'

// 工具元信息（来自主进程 tool.list）：主页网格与全局搜索共用
const props = defineProps({
  tools: { type: Array as PropType<ToolMeta[]>, default: () => [] }
})
const emit = defineEmits<{
  toolsChanged: []
  /** 置顶列表变化（主页卡片 / 编辑弹窗触发），根布局据此同步侧边条置顶区 */
  pinsChanged: [ids: string[]]
}>()

// 主页标签：始终存在且不可关闭，作为默认视图
const HOME_TAB: OpenTool = { kind: 'home', id: 'home', title: '主页' }
const openTabs = ref<OpenTool[]>([HOME_TAB])
const activeTabId = ref(HOME_TAB.id)

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
    openTabs.value.push({ kind: 'tool', id: tool.id, title: tool.title, icon: tool.icon })
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

// 打开开发者标签页：若已打开则激活，否则新开一个
function openDeveloperTab(): void {
  if (!openTabs.value.some((t) => t.kind === 'developer')) {
    openTabs.value.push({ kind: 'developer', id: 'developer', title: '开发者' })
  }
  activate('developer')
}

// 打开 UI 测试标签页：若已打开则激活，否则新开一个
function openUiTestTab(): void {
  if (!openTabs.value.some((t) => t.kind === 'ui-test')) {
    openTabs.value.push({ kind: 'ui-test', id: 'ui-test', title: 'UI 测试' })
  }
  activate('ui-test')
}

// 打开某工具的「代码浏览」标签页：同一工具只有一个代码页，已打开则激活
function openToolCode(tool: ToolDetailMeta): void {
  const id = `${tool.id}:code`
  if (!openTabs.value.some((t) => t.id === id)) {
    openTabs.value.push({
      kind: 'tool-code',
      id,
      title: `${tool.title} · 代码`,
      toolId: tool.id,
      toolTitle: tool.title
    })
  }
  activate(id)
}

// 打开某工具的「版本历史」标签页：同一工具只有一个历史页，已打开则激活
function openToolHistory(tool: ToolDetailMeta): void {
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

// 打开某工具的「档案」标签页：同一工具只有一个档案页，已打开则激活
function openToolArchive(tool: ToolDetailMeta): void {
  const id = `${tool.id}:archive`
  if (!openTabs.value.some((t) => t.id === id)) {
    openTabs.value.push({
      kind: 'tool-archive',
      id,
      title: `${tool.title} · 档案`,
      toolId: tool.id,
      toolTitle: tool.title
    })
  }
  activate(id)
}

// 打开某工具的「数据」标签页：同一工具只有一个数据页，已打开则激活
function openToolData(toolId: string, toolTitle: string): void {
  const id = `${toolId}:data`
  if (!openTabs.value.some((t) => t.id === id)) {
    openTabs.value.push({
      kind: 'tool-data',
      id,
      title: `${toolTitle} · 数据`,
      toolId,
      toolTitle
    })
  }
  activate(id)
}

// 工具页内生成器重写 index.html + meta.json 后，同步更新标签标题
function renameTab(id: string, title: string): void {
  const tab = openTabs.value.find((t) => t.id === id)
  if (tab) tab.title = title
}

// 工作区 tab 状态上报主进程：agent_workspace_tabs 工具据此回答「当前打开了哪些页面」。
// deep：renameTab / confirmEditTool 会就地改 tab.title；immediate：挂载即上报，避免查询时为空。
watch(
  [openTabs, activeTabId],
  () => {
    void window.api.workspace.tabsChanged({
      tabs: openTabs.value.map((t) => ({ ...t })),
      activeTabId: activeTabId.value
    })
  },
  { deep: true, immediate: true }
)

// —— 工具详情面板 ref 映射（tool 标签均保持挂载，切换标签不卸载）——
const detailRefs = ref<Record<string, InstanceType<typeof ToolDetailPanel> | null>>({})

/** 刷新某工具详情面板（生成器改动落盘后由全局会话的 onToolApplied 触发） */
function reloadTool(id: string): void {
  detailRefs.value[id]?.reload()
}

/** 同步某工具标签标题（生成器改动可能更新工具标题，由 onToolApplied 触发） */
function renameTool(id: string, title: string): void {
  renameTab(id, title)
}

const toolError = ref('')

// —— 工具分组（用户独立配置 / 不落 meta.json）——
// 分组映射：toolId → 分组名，由主进程 tool.group 读写；主页网格按此分区展示。
const groupMap = ref<Record<string, string>>({})

async function loadGroups(): Promise<void> {
  try {
    groupMap.value = await window.api.tool.group.list()
  } catch (error) {
    console.error('加载工具分组失败', error)
  }
}

// 已存在的分组名列表（编辑弹窗「分组」输入框的 datalist 建议）
const existingGroups = computed(() => Array.from(new Set(Object.values(groupMap.value).filter(Boolean))))

onMounted(loadGroups)

// —— 工具置顶（用户独立配置 / 不落 meta.json）——
// 置顶 id 列表（按置顶顺序），由主进程 tool.pin 读写；主页「常用」分区与侧边条置顶区共用。
const pinnedIds = ref<string[]>([])

async function loadPins(): Promise<void> {
  try {
    pinnedIds.value = await window.api.tool.pin.list()
  } catch (error) {
    console.error('加载工具置顶失败', error)
  }
}

/** 切换某工具置顶状态（主页卡片 pin 按钮）：成功后同步侧边条置顶区。 */
async function togglePin(tool: ToolMeta): Promise<void> {
  const pinned = !pinnedIds.value.includes(tool.id)
  pinnedIds.value = await window.api.tool.pin.set(tool.id, pinned)
  emit('pinsChanged', [...pinnedIds.value])
}

onMounted(loadPins)

// —— 编辑工具弹窗：编辑名称 / 图标（单字符）/ 描述 / 分组，提交后落盘 meta.json 与分组映射并同步展示 ——
const editTarget = ref<ToolMeta | null>(null)
const editDialogOpen = computed({
  get: () => !!editTarget.value,
  set: (open: boolean) => {
    if (!open) editTarget.value = null
  }
})

// 编辑弹窗点击卡片编辑按钮：回填当前元信息由子组件 watch 处理
function askEditTool(tool: ToolMeta): void {
  editTarget.value = tool
}

// 保存编辑：更新名称 / 图标 / 描述 / 分组 / 置顶，成功后同步已打开标签的标题与图标，并刷新工具列表。
async function confirmEditTool(payload: { title: string; icon: string; description: string; group: string; pinned: boolean }): Promise<void> {
  const tool = editTarget.value
  if (!tool) return
  editTarget.value = null
  toolError.value = ''
  const res = await window.api.tool.updateMeta(tool.id, {
    title: payload.title,
    description: payload.description,
    icon: payload.icon
  })
  if (!res.ok) {
    toolError.value = res.error
    return
  }
  // 分组是用户独立配置，单独落盘；仅在分组名变化时写回
  const currentGroup = groupMap.value[tool.id] ?? ''
  if (payload.group.trim() !== currentGroup) {
    groupMap.value = await window.api.tool.group.set(tool.id, payload.group)
  }
  // 置顶是用户独立配置，单独落盘；仅在置顶状态变化时写回
  const currentPinned = pinnedIds.value.includes(tool.id)
  if (payload.pinned !== currentPinned) {
    pinnedIds.value = await window.api.tool.pin.set(tool.id, payload.pinned)
    emit('pinsChanged', [...pinnedIds.value])
  }
  // 名称/图标变化时，同步已打开标签页展示
  const tab = openTabs.value.find((t) => t.id === tool.id)
  if (tab) {
    if (res.title) tab.title = res.title
    if (res.icon !== undefined) tab.icon = res.icon
  }
  emit('toolsChanged')
}

// 点击「新建工具」：由主进程立即创建一个工具文件夹（index.html + meta.json），
// 随后在本工作台打开该工具的标签页（三栏工具页由激活标签驱动）。
async function createTool(): Promise<void> {
  toolError.value = ''
  const res = await window.api.tool.create()
  if (!res.ok) {
    toolError.value = res.error
    return
  }
  const tab: OpenTool = { kind: 'tool', id: res.id, title: res.title ?? '新工具' }
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

// 用户在弹窗中确认删除：keepData 决定是否保留数据区；若该工具标签已打开则一并关闭，随后刷新工具列表。
async function confirmDeleteTool(keepData: boolean): Promise<void> {
  const tool = deleteTarget.value
  if (!tool) return
  deleteTarget.value = null
  toolError.value = ''
  const res = await window.api.tool.delete(tool.id, keepData)
  if (!res.ok) {
    toolError.value = res.error ?? '删除工具失败'
    return
  }
  closeTab(tool.id)
  emit('toolsChanged')
}

// 暴露给根布局：左侧导航栏「新建工具」「设置」、全宽顶栏搜索下拉「打开工具」，
// 以及全局会话应用多工具意图后刷新工具详情 / 同步标签标题
defineExpose({ createTool, openTool, openSettingsTab, openDeveloperTab, openUiTestTab, reloadTool, renameTool })
</script>

<template>
  <div class="tool-workspace">
    <!-- 标签栏 + 内容面板：使用 shadcn Tabs（主页 / 已打开工具 / 设置 / 版本历史） -->
    <ui-tabs
      v-model="activeTabId"
      :default-value="HOME_TAB.id"
      activation-mode="manual"
      :unmount-on-hide="false"
      class="flex min-h-0 flex-1 flex-col"
    >
      <workspace-tabs
        v-if="openTabs.length"
        :tabs="openTabs"
        :active-id="activeTabId"
        :home-tab-id="HOME_TAB.id"
        @close="closeTab"
      />

      <ui-tabs-content
        v-for="tab in openTabs"
        :key="tab.id"
        :value="tab.id"
        class="relative mt-0 min-h-0 flex-1"
      >
        <!-- 主页：所有工具网格 + 新增工具 -->
        <home-panel
          v-if="tab.kind === 'home'"
          :tools="props.tools"
          :group-map="groupMap"
          :pinned-ids="pinnedIds"
          :error="toolError"
          @create="createTool"
          @open="openTool"
          @edit="askEditTool"
          @delete="askDeleteTool"
          @pin="togglePin"
        />
        <!-- 工具详情：工具标签只渲染详情面板（会话历史/当前会话已上浮为全局三栏） -->
        <tool-detail-panel
          v-else-if="tab.kind === 'tool'"
          :ref="(el) => (detailRefs[tab.id] = el as InstanceType<typeof ToolDetailPanel> | null)"
          :tool="{ id: tab.id, title: tab.title, icon: tab.icon }"
          @open-history="openToolHistory"
          @open-archive="openToolArchive"
          @open-code="openToolCode"
        />
        <!-- 工具版本历史：展示该工具的 git 提交记录 -->
        <tool-history
          v-else-if="tab.kind === 'tool-history'"
          :tool-id="tab.toolId ?? ''"
          :tool-title="tab.toolTitle ?? tab.title"
        />
        <!-- 工具档案：展示 / 编辑该工具的 archive.md -->
        <tool-archive-panel
          v-else-if="tab.kind === 'tool-archive'"
          :tool-id="tab.toolId ?? ''"
          :tool-title="tab.toolTitle ?? tab.title"
        />
        <!-- 工具源码：展示该工具白名单源码文件树 + 文件内容 -->
        <tool-code-browser
          v-else-if="tab.kind === 'tool-code'"
          :tool-id="tab.toolId ?? ''"
          :tool-title="tab.toolTitle ?? tab.title"
        />
        <!-- 工具数据详情：展示该工具的数据区（键 / 大小 / 时间） -->
        <tool-data-detail
          v-else-if="tab.kind === 'tool-data'"
          :tool-id="tab.toolId ?? ''"
          :tool-title="tab.toolTitle ?? tab.title"
        />
        <!-- 设置标签：渲染设置面板 -->
        <settings-panel v-else-if="tab.kind === 'settings'" @open-tool-data="openToolData" @open-developer="openDeveloperTab" />
        <!-- 开发者界面：展示全部 Agent 工具介绍 -->
        <developer-panel v-else-if="tab.kind === 'developer'" />
        <!-- UI 测试：mock 数据预览思考与执行过程展示方案 -->
        <ui-test-panel v-else-if="tab.kind === 'ui-test'" />
      </ui-tabs-content>
    </ui-tabs>

    <!-- 删除工具确认弹窗：使用 UI 弹窗而非原生 confirm -->
    <tool-delete-dialog
      :open="deleteDialogOpen"
      :tool="deleteTarget"
      @update:open="(v) => (deleteDialogOpen = v)"
      @confirmed="confirmDeleteTool"
    />

    <!-- 编辑工具弹窗：修改名称 / 图标（单字符）/ 描述 / 分组 / 置顶 -->
    <tool-edit-dialog
      :open="editDialogOpen"
      :tool="editTarget"
      :group="editTarget ? (groupMap[editTarget.id] ?? '') : ''"
      :pinned="editTarget ? pinnedIds.includes(editTarget.id) : false"
      :existing-groups="existingGroups"
      @update:open="(v) => (editDialogOpen = v)"
      @saved="confirmEditTool"
    />
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
</style>
