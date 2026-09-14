<script setup lang="ts">
// 工作台标签页宿主。
//
// 产品形态（用户 2026-09-13 定）：side panel = 应用入口 = AI 对话；设置 / 脚本这些重界面
// 退到独立标签页 —— 本组件就是那个标签页。
//
// 结构平移自桌面版 app.vue 的「顶栏 + 左侧导航 + 工作区」，只裁掉两栏聊天
// （会话历史 | 当前会话已移入 side panel），保留的分支逐句照搬，未重写。
// 2026-09-14：原 46px 顶栏已删除（它存在的唯一理由就是承载那个居中的全局搜索框）；
// 同日工具链路移除（docs/tool-chain-removal-plan.md）后，左侧导航的置顶工具区与
// 「新建工具」按钮一并摘除；开发者界面（内容 100% 是工具能力面）同批删除，
// 导航只剩：设置 / UI 测试 / 用户脚本管理器 / 脚本列表。
import { ref } from 'vue'
import {
  Braces as UiBraces,
  FlaskConical as UiFlaskConical,
  FolderTree as UiFolderTree,
  List as UiList,
  Settings as UiSettings
} from '@lucide/vue'
import WorkspaceHost from '@/components/WorkspaceHost.vue'
import UserscriptManager from '@/components/userscript/UserscriptManager.vue'

// 左侧导航栏「设置」「脚本列表」等：调用工作区的对应方法
const workspaceRef = ref<InstanceType<typeof WorkspaceHost> | null>(null)

// 用户脚本管理器：内嵌全屏面板（复用 workbench 单一 HTML 入口，规避多 HTML 入口在 rolldown-vite 下 plugin-vue compiler 未初始化）
const showUserscriptManager = ref(false)

/** 切换用户脚本管理器面板（内嵌全屏覆盖层） */
function openUserscriptManager(): void {
  showUserscriptManager.value = true
}

/**
 * 管理器里点某个脚本的「编辑」：关掉覆盖层，改在工作区标签页里打开该脚本的编辑器。
 * 编辑器实现只有一份（UserscriptEditorPanel），管理器那边不再内联编辑器。
 */
function onUserscriptEdit(uuid: string, title: string): void {
  showUserscriptManager.value = false
  workspaceRef.value?.openUserscriptEditor(uuid, title)
}
</script>

<template>
  <div class="workspace">
    <!-- 2026-09-14：原 46px 顶栏（存在的唯一理由是承载那个居中的全局搜索框）已删除；
         同日工具链路移除后，该搜索框与置顶工具区一并消失，本组件不再持有任何工具状态。 -->

    <!-- 左侧图标导航栏 + 右侧工作区 -->
    <div class="workspace-main">
      <aside class="workspace-nav">
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
          aria-label="用户脚本"
          title="用户脚本管理器"
          @click="openUserscriptManager"
        >
          <ui-braces class="size-5" />
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
      </aside>

      <section class="workspace-panel workspace-panel--grow">
        <!-- 多标签页：主页（内容待定）/ 设置 / UI 测试 / 脚本列表 / 脚本编辑器 / lfs 浏览 -->
        <workspace-host ref="workspaceRef" />
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
      <UserscriptManager @edit="onUserscriptEdit" />
    </div>
  </Teleport>
</template>
