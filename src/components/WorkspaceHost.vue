<script setup lang="ts">
// 工作区多标签宿主：主页（内容待定）/ 设置 / UI 测试 / 脚本列表 / 脚本编辑器。
//
// 2026-09-14：工具链路移除（docs/tool-chain-removal-plan.md）后，本文件从「工具标签总线」
// 收窄为「脚本工作台」—— 原先的工具详情 / 代码 / 版本历史 / 档案 / 数据 五个标签页、主页工具网格、
// 全局工具搜索框、编辑与删除弹窗、分组与置顶全部摘除；标签页宿主、dirtyTab 与 tabsChanged 上报
// 这套骨架逐句保留，未重写。主页标签本身保留（决策 D），内容刻意留空待定。
import { ref, watch } from 'vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import UiTestPanel from '@/components/UiTestPanel.vue'
import WorkspaceTabs from '@/components/WorkspaceTabs.vue'
import UserscriptListPanel from '@/components/userscript/UserscriptListPanel.vue'
import UserscriptEditorPanel from '@/components/userscript/UserscriptEditorPanel.vue'
import type { WorkspaceTab } from '@/types/tab'
import {
  Tabs as UiTabs,
  TabsContent as UiTabsContent
} from '@/components/ui/tabs'

// 主页标签：始终存在且不可关闭，作为默认视图。内容自 2026-09-14 起刻意留空（原为工具网格）
const HOME_TAB: WorkspaceTab = { kind: 'home', id: 'home', title: '主页' }
const openTabs = ref<WorkspaceTab[]>([HOME_TAB])
const activeTabId = ref(HOME_TAB.id)

function activate(id: string): void {
  activeTabId.value = id
}

/** 编辑器标签的未保存状态（key = 标签 id）。编辑器内容区不自带关闭按钮，关闭统一走标签栏，
 *  因此「有未保存改动」的确认挪到这里，由编辑器通过 @dirty 上报。 */
const dirtyTabs = ref<Record<string, boolean>>({})

function closeTab(id: string): void {
  // 主页标签始终保留，不可关闭
  if (id === HOME_TAB.id) return
  if (dirtyTabs.value[id] && !confirm('有未保存的修改，确认关闭？')) return
  const idx = openTabs.value.findIndex((t) => t.id === id)
  if (idx === -1) return
  openTabs.value = openTabs.value.filter((t) => t.id !== id)
  delete dirtyTabs.value[id]
  if (activeTabId.value === id) {
    const next = openTabs.value[Math.max(0, idx - 1)] ?? openTabs.value[0]
    activeTabId.value = next?.id ?? ''
  }
}

// 打开设置标签页：若已打开则激活，否则新开一个
function openSettingsTab(): void {
  if (!openTabs.value.some((t) => t.kind === 'settings')) {
    openTabs.value.push({ kind: 'settings', id: 'settings', title: '设置' })
  }
  activate('settings')
}

// 打开 UI 测试标签页：若已打开则激活，否则新开一个
function openUiTestTab(): void {
  if (!openTabs.value.some((t) => t.kind === 'ui-test')) {
    openTabs.value.push({ kind: 'ui-test', id: 'ui-test', title: 'UI 测试' })
  }
  activate('ui-test')
}

// 打开脚本列表标签页：若已打开则激活，否则新开一个。
// 注意与 UserscriptManager 区分 —— 那是左侧导航另一个按钮打开的全屏覆盖层（新建 / 编辑器），
// 本标签页只做「看列表 + 启停」。
function openUserscriptListTab(): void {
  if (!openTabs.value.some((t) => t.kind === 'userscript-list')) {
    openTabs.value.push({ kind: 'userscript-list', id: 'userscript-list', title: '脚本列表' })
  }
  activate('userscript-list')
}

/** 打开某脚本的编辑器标签页：每脚本一个（id = us-edit:<uuid>），已打开则激活复用 */
function openUserscriptEditor(uuid: string, title: string): void {
  const id = `us-edit:${uuid}`
  if (!openTabs.value.some((t) => t.id === id)) {
    openTabs.value.push({
      kind: 'userscript-edit',
      id,
      title: title || '脚本编辑',
      userscriptId: uuid
    })
  }
  activate(id)
}

/**
 * 脚本被删除（列表页广播）：关掉它可能开着的编辑器标签。
 * 先清脏标记再关 —— 脚本连 git 仓都被删了，未保存的改动已无处可存，不该再弹确认。
 */
function onUserscriptDeleted(uuid: string): void {
  const id = `us-edit:${uuid}`
  delete dirtyTabs.value[id]
  if (openTabs.value.some((t) => t.id === id)) closeTab(id)
}

// 工作区 tab 状态上报主进程：agent_workspace_tabs 工具据此回答「当前打开了哪些页面」。
// immediate：挂载即上报，避免查询时为空。
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

// 暴露给根布局：左侧导航栏「设置 / UI 测试 / 脚本列表」与脚本管理器的「编辑」入口
defineExpose({ openSettingsTab, openUiTestTab, openUserscriptListTab, openUserscriptEditor })
</script>

<template>
  <div class="workspace-host">
    <!-- 标签栏 + 内容面板：使用 shadcn Tabs（主页 / 设置 / UI 测试 / 脚本列表 / 脚本编辑器） -->
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
        <!-- 主页：内容待定 —— 原工具网格已随工具链路移除，此处刻意留空，不渲染任何内容 -->
        <div v-if="tab.kind === 'home'" class="h-full" />
        <!-- 设置标签：渲染设置面板 -->
        <settings-panel v-else-if="tab.kind === 'settings'" />
        <!-- UI 测试：mock 数据预览思考与执行过程展示方案 -->
        <ui-test-panel v-else-if="tab.kind === 'ui-test'" />
        <!-- 脚本列表：列出全部用户脚本 + 启停；「编辑」开对应的编辑器标签页 -->
        <userscript-list-panel
          v-else-if="tab.kind === 'userscript-list'"
          @edit="openUserscriptEditor"
          @deleted="onUserscriptDeleted"
        />
        <!-- 用户脚本编辑器：每脚本一个标签页；脏状态上报给 closeTab 做关闭前确认 -->
        <userscript-editor-panel
          v-else-if="tab.kind === 'userscript-edit'"
          :key="tab.id"
          :uuid="tab.userscriptId ?? ''"
          @dirty="(v: boolean) => (dirtyTabs[tab.id] = v)"
        />
      </ui-tabs-content>
    </ui-tabs>
  </div>
</template>

<style scoped lang="less">
.workspace-host {
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
