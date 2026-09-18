<script setup lang="ts">
// 工作台标签页宿主。
//
// 产品形态（用户 2026-09-13 定）：side panel = 应用入口 = AI 对话；设置 / 脚本这些重界面
// 退到独立标签页 —— 本组件就是那个标签页。
//
// 结构平移自桌面版 app.vue 的「顶栏 + 左侧导航 + 工作区」，只裁掉两栏聊天
// （会话历史 | 当前会话已移入 side panel），保留的分支逐句照搬，未重写。
// 2026-09-14：原 46px 顶栏已删除（它存在的唯一理由就是承载那个居中的全局搜索框）；
// 同日工具链路移除后，左侧导航的置顶工具区与
// 「新建工具」按钮一并摘除；开发者界面（内容 100% 是工具能力面）同批删除。
// 2026-09-15：用户脚本管理器覆盖层删除（能力全部并入脚本列表标签页），导航只剩：
// 设置 / UI 测试 / 脚本列表。
import { onMounted, onUnmounted, ref } from 'vue'
import {
  AlertTriangle as UiAlertTriangle,
  Compass as UiCompass,
  Database as UiDatabase,
  FlaskConical as UiFlaskConical,
  FolderTree as UiFolderTree,
  List as UiList,
  Settings as UiSettings
} from '@lucide/vue'
import WorkspaceHost from '@/components/WorkspaceHost.vue'
import { getProject } from '@/lib/userscripts/project-store'

// 左侧导航栏「设置」「脚本列表」等：调用工作区的对应方法
const workspaceRef = ref<InstanceType<typeof WorkspaceHost> | null>(null)

// hash 深链（openWorkbench 的既定约定，2026-09-15 才真正实现）：
//   #/tool/<uuid> → 直达该脚本编辑器（AI 生成卡片「进编辑器」用，title 取状态库名称）
//   #/errors/<uuid> → 打开错误日志标签页并定位到该脚本（页面浮窗点击脚本行跳转）
//   #/settings    → 打开设置标签页
//   #/guide       → 打开引导标签页（侧边栏「查看开启引导」跳这里）
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
  if (location.hash === '#/settings') workspaceRef.value?.openSettingsTab()
}

onMounted(() => {
  handleHash()
  // 已打开的工作台被再次深链时，浮窗走的是 chrome.tabs.update 只改 hash（文档不重载），
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
        <!-- 引导：需要用户去浏览器里开权限/开关的集中说明页，各处「查看开启引导」都落这里 -->
        <button
          class="workspace-nav-item"
          type="button"
          aria-label="引导"
          title="引导（开启运行用户脚本等权限）"
          @click="workspaceRef?.openGuideTab()"
        >
          <ui-compass class="size-5" />
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
          aria-label="UI 测试"
          title="UI 测试"
          @click="workspaceRef?.openUiTestTab()"
        >
          <ui-flask-conical class="size-5" />
        </button>
        <button
          class="workspace-nav-item"
          type="button"
          aria-label="脚本列表"
          title="脚本列表"
          @click="workspaceRef?.openUserscriptListTab()"
        >
          <ui-list class="size-5" />
        </button>
        <button
          class="workspace-nav-item"
          type="button"
          aria-label="错误日志"
          title="错误日志（按脚本分类：运行期报错 / 注册失败 / DL 桥失败）"
          @click="workspaceRef?.openErrorLogTab()"
        >
          <ui-alert-triangle class="size-5" />
        </button>
        <button
          class="workspace-nav-item"
          type="button"
          aria-label="lfs 浏览"
          title="lfs 浏览（offscreen lightning-fs 整库只读视图）"
          @click="workspaceRef?.openLfsBrowserTab()"
        >
          <ui-folder-tree class="size-5" />
        </button>
        <button
          class="workspace-nav-item"
          type="button"
          aria-label="会话数据"
          title="会话数据（IndexedDB 会话库落盘原始记录，只读）"
          @click="workspaceRef?.openChatDataTab()"
        >
          <ui-database class="size-5" />
        </button>
      </aside>

      <section class="workspace-panel workspace-panel--grow">
        <!-- 多标签页容器：左侧导航各项各自开标签，默认落脚本列表（不可关闭） -->
        <workspace-host ref="workspaceRef" />
      </section>
    </div>
  </div>
</template>
