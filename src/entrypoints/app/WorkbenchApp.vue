<script setup lang="ts">
// 工作台标签页宿主。
//
// 产品形态：side panel = 应用入口 = AI 对话；设置 / 脚本这些重界面退到独立标签页
// —— 本组件就是那个标签页。
//
// 结构平移自桌面版 app.vue 的「顶栏 + 左侧导航 + 工作区」，只裁掉两栏聊天
// （会话历史 | 当前会话已移入 side panel），保留的分支逐句照搬，未重写。
// 导航项：引导 / 设置 / UI 测试 / 脚本列表 / 运行日志 / lfs 浏览 / 会话数据 / 会话历史 / AI 工具 / GM API。
import { onMounted, onUnmounted, ref } from 'vue'
import {
  Code as UiCode,
  History as UiHistory,
  Compass as UiCompass,
  Database as UiDatabase,
  FlaskConical as UiFlaskConical,
  FolderTree as UiFolderTree,
  List as UiList,
  MessagesSquare as UiMessagesSquare,
  Settings as UiSettings,
  Wrench as UiWrench
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
//   #/guide       → 打开引导标签页（对话界面「查看开启引导」跳这里）
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
onUnmounted(() => window.removeEventListener('hashchange', handleHash))
</script>

<template>
  <div class="workspace">
    <!-- 2026-09-14：原 46px 顶栏（存在的唯一理由是承载那个居中的全局搜索框）已删除；
         同日工具链路移除后，该搜索框与置顶工具区一并消失，本组件不再持有任何工具状态。 -->

    <!-- 左侧图标导航栏 + 右侧工作区 -->
    <div class="workspace-main">
      <aside class="workspace-nav">
        <ui-tooltip-provider>
          <!-- 引导：需要用户去浏览器里开权限/开关的集中说明页，各处「查看开启引导」都落这里 -->
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <button
                class="workspace-nav-item"
                type="button"
                aria-label="引导"
                @click="workspaceRef?.openGuideTab()"
              >
                <ui-compass class="size-5" />
              </button>
            </ui-tooltip-trigger>
            <ui-tooltip-content side="right">引导</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
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
                aria-label="UI 测试"
                @click="workspaceRef?.openUiTestTab()"
              >
                <ui-flask-conical class="size-5" />
              </button>
            </ui-tooltip-trigger>
            <ui-tooltip-content side="right">UI 测试</ui-tooltip-content>
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
                aria-label="lfs 浏览"
                @click="workspaceRef?.openLfsBrowserTab()"
              >
                <ui-folder-tree class="size-5" />
              </button>
            </ui-tooltip-trigger>
            <ui-tooltip-content side="right">lfs 浏览</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <button
                class="workspace-nav-item"
                type="button"
                aria-label="会话数据"
                @click="workspaceRef?.openChatDataTab()"
              >
                <ui-database class="size-5" />
              </button>
            </ui-tooltip-trigger>
            <ui-tooltip-content side="right">会话数据</ui-tooltip-content>
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
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <button
                class="workspace-nav-item"
                type="button"
                aria-label="AI 工具"
                @click="workspaceRef?.openAgentToolsTab()"
              >
                <ui-wrench class="size-5" />
              </button>
            </ui-tooltip-trigger>
            <ui-tooltip-content side="right">AI 工具</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <button
                class="workspace-nav-item"
                type="button"
                aria-label="GM API"
                @click="workspaceRef?.openGmApiTab()"
              >
                <ui-code class="size-5" />
              </button>
            </ui-tooltip-trigger>
            <ui-tooltip-content side="right">GM API</ui-tooltip-content>
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
