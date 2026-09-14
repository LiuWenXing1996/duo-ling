<script setup lang="ts">
// 工作区标签栏：主页 / 已打开工具 / 设置 / 版本历史。主页标签始终存在且不可关闭。
// 2026-09-14：workbench 原 46px 顶栏（存在的唯一理由是放全局搜索框）删除，
// 搜索框改由右侧 #actions 插槽承载、由 ToolWorkspace 注入。标签区 flex-1 且可横向滚动，
// 搜索框固定在右侧、不随标签滚动。
import type { OpenTool } from '@/types/tab'
import {
  FileCode2 as UiFileCode,
  GitBranch as UiGitBranch,
  Home as UiHome,
  List as UiList,
  Settings as UiSettings,
  X as UiX
} from '@lucide/vue'
import {
  TabsList as UiTabsList,
  TabsTrigger as UiTabsTrigger
} from '@/components/ui/tabs'
import ToolIcon from './ToolIcon.vue'

const props = defineProps<{
  tabs: OpenTool[]
  activeId: string
  homeTabId: string
}>()
const emit = defineEmits<{
  close: [id: string]
}>()
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
        <tool-icon v-else-if="tab.kind === 'tool'" :icon="tab.icon" :fallback="tab.title" class="shrink-0 text-[13px]" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <ui-git-branch v-else-if="tab.kind === 'tool-history'" class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <ui-file-code v-else-if="tab.kind === 'tool-code'" class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <ui-list v-else-if="tab.kind === 'userscript-list'" class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
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

    <div v-if="$slots.actions" class="shrink-0 pr-2">
      <slot name="actions" />
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
