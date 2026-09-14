<script setup lang="ts">
// 工作区标签栏：主页 / 设置 / 开发者 / UI 测试 / 脚本列表 / 脚本编辑器。主页标签始终存在且不可关闭。
// 2026-09-14：workbench 原 46px 顶栏（存在的唯一理由是放全局搜索框）删除，搜索框改由右侧
// #actions 插槽承载；同日工具链路移除（docs/tool-chain-removal-plan.md）后，该搜索框的数据源
// tool.list() 消失，插槽连同搜索框一并删除，工具类标签（tool / tool-history / tool-code）分支同步摘除。
import type { WorkspaceTab } from '@/types/tab'
import {
  Home as UiHome,
  List as UiList,
  Pencil as UiPencil,
  Settings as UiSettings,
  X as UiX
} from '@lucide/vue'
import {
  TabsList as UiTabsList,
  TabsTrigger as UiTabsTrigger
} from '@/components/ui/tabs'

const props = defineProps<{
  tabs: WorkspaceTab[]
  activeId: string
  homeTabId: string
}>()
const emit = defineEmits<{
  close: [id: string]
}>()

// 构建信息（wxt.config.ts 的 buildInfoPlugin 注入）：标签栏右侧展示，用于一眼判断
// 「浏览器里跑的是不是最新代码」。dev 模式下 time = 页面加载时刻（刷新即更新），
// build 模式下 = 产物构建时刻。
declare global {
  interface Window {
    __BUILD_INFO__?: { time: string; branch: string }
  }
}

const buildInfo = (() => {
  const info = window.__BUILD_INFO__
  if (!info) return null
  const d = new Date(info.time)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return {
    branch: info.branch,
    time: `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  }
})()
</script>

<template>
  <div class="flex h-12 shrink-0 items-center border-b border-border bg-muted">
    <ui-tabs-list
      class="workspace-tabs h-full min-w-0 flex-1 justify-start gap-1 overflow-x-auto rounded-none bg-transparent p-1"
      aria-label="工作区标签"
    >
      <ui-tabs-trigger
        v-for="tab in props.tabs"
        :key="tab.id"
        :value="tab.id"
        as="div"
        class="gap-1.5 text-[12.5px]"
      >
        <ui-home v-if="tab.kind === 'home'" class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <ui-list v-else-if="tab.kind === 'userscript-list'" class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <ui-pencil v-else-if="tab.kind === 'userscript-edit'" class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <ui-settings v-else class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <span class="truncate">{{ tab.title }}</span>
        <button
          v-if="tab.kind !== 'home'"
          class="no-drag ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          type="button"
          aria-label="关闭标签"
          @mousedown.stop
          @click.stop="emit('close', tab.id)"
        >
          <ui-x class="size-3" />
        </button>
      </ui-tabs-trigger>
    </ui-tabs-list>

    <!-- 构建 / 加载信息（分支 + 时间）：右对齐，muted 弱化不抢视线 -->
    <div
      v-if="buildInfo"
      class="ml-auto shrink-0 select-none px-3 text-right font-mono text-[10px] leading-tight text-muted-foreground"
      title="分支 + 加载时刻（dev）或构建时刻（build），用来确认浏览器里跑的是不是最新代码"
    >
      <div class="truncate">{{ buildInfo.branch }}</div>
      <div>{{ buildInfo.time }}</div>
    </div>
  </div>
</template>

<style scoped>
/* 隐藏 tab 栏横向滚动条，但保留横向滚动能力 */
.workspace-tabs {
  scrollbar-width: none;
}
.workspace-tabs::-webkit-scrollbar {
  display: none;
}
</style>
