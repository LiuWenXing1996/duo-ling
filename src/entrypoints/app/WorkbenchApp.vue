<script setup lang="ts">
// 工作台标签页宿主。
//
// 产品形态：side panel = 应用入口 = AI 对话；设置 / 脚本这些重界面退到独立标签页
// —— 本组件就是那个标签页。
//
// 结构平移自桌面版 app.vue 的「顶栏 + 左侧导航 + 工作区」，只裁掉两栏聊天
// （会话历史 | 当前会话已移入 side panel），保留的分支逐句照搬，未重写。
// 导航项：设置 / 脚本列表 / 运行日志 / 会话历史（「引导」不单独占一项，入口在设置页菜单里）。
// 调界面用的几个调试面板不在这里 —— 入口收在「设置 · 开发者」分区里（见 DevModeSection）。
import { onMounted, onUnmounted, ref } from 'vue'
import {
  History as UiHistory,
  List as UiList,
  MessagesSquare as UiMessagesSquare,
  Settings as UiSettings
} from '@lucide/vue'
import WorkspaceHost from '@/components/WorkspaceHost.vue'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger
} from '@/components/ui/tooltip'
import { getProject } from '@/lib/userscripts/project-store'

// 左侧导航栏「设置」「脚本列表」等：调用工作区的对应方法
const workspaceRef = ref<InstanceType<typeof WorkspaceHost> | null>(null)

// hash 深链（openWorkbench 的约定）：
//   #/tool/<uuid> → 直达该脚本编辑器（AI 生成卡片「进编辑器」用，title 取状态库名称）
//   #/errors/<uuid> → 打开运行日志标签页并定位到该脚本（对话界面灵动岛点击脚本行跳转）
//   #/settings    → 打开设置标签页
//   #/guide       → 打开引导标签页（对话界面与设置页菜单里的「查看开启引导」都跳这里）
//   #/sessions    → 打开会话历史标签页（对话界面顶栏「会话历史」跳这里）
function handleHash(): void {
  const tool = location.hash.match(/^#\/tool\/([A-Za-z0-9-]+)/)
  if (tool) {
    void getProject(tool[1]).then((p) => {
      workspaceRef.value?.openUserscriptEditor(tool[1], p?.name ?? '')
    })
    return
  }
  const err = location.hash.match(/^#\/errors\/([A-Za-z0-9-]+)/)
  if (err) {
    workspaceRef.value?.openErrorLogTab(err[1])
    return
  }
  if (location.hash === '#/guide') {
    workspaceRef.value?.openGuideTab()
    return
  }
  if (location.hash === '#/sessions') {
    workspaceRef.value?.openSessionHistoryTab()
    return
  }
  if (location.hash === '#/settings') workspaceRef.value?.openSettingsTab()
}

onMounted(() => {
  handleHash()
  // 已打开的工作台被再次深链时，SW 走的是 chrome.tabs.update 只改 hash（文档不重载），
  // 只靠 onMounted 会「点了没反应」——必须接住 hashchange。
  window.addEventListener('hashchange', handleHash)
})
onUnmounted(() => {
  window.removeEventListener('hashchange', handleHash)
})
</script>

<template>
  <div class="workspace">
    <!-- 左侧图标导航栏 + 右侧工作区 -->
    <div class="workspace-main">
      <aside class="workspace-nav">
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <button
                class="workspace-nav-item"
                type="button"
                aria-label="设置"
                @click="workspaceRef?.openSettingsTab()"
              >
                <ui-settings class="size-5" />
              </button>
            </ui-tooltip-trigger>
            <ui-tooltip-content side="right">设置</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <button
                class="workspace-nav-item"
                type="button"
                aria-label="脚本列表"
                @click="workspaceRef?.openUserscriptListTab()"
              >
                <ui-list class="size-5" />
              </button>
            </ui-tooltip-trigger>
            <ui-tooltip-content side="right">脚本列表</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <button
                class="workspace-nav-item"
                type="button"
                aria-label="运行日志"
                @click="workspaceRef?.openErrorLogTab()"
              >
                <ui-history class="size-5" />
              </button>
            </ui-tooltip-trigger>
            <ui-tooltip-content side="right">运行日志</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <button
                class="workspace-nav-item"
                type="button"
                aria-label="会话历史"
                @click="workspaceRef?.openSessionHistoryTab()"
              >
                <ui-messages-square class="size-5" />
              </button>
            </ui-tooltip-trigger>
            <ui-tooltip-content side="right">会话历史</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
      </aside>

      <section class="workspace-panel workspace-panel--grow">
        <!-- 多标签页容器：左侧导航各项各自开标签，默认落脚本列表（不可关闭） -->
        <workspace-host ref="workspaceRef" />
      </section>
    </div>
  </div>
</template>
