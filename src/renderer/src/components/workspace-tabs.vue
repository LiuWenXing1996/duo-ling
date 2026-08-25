<script setup lang="ts">
// 工作区标签栏：主页 / 已打开工具 / 设置 / 版本历史。主页标签始终存在且不可关闭。
import type { OpenTool } from '@/types/tab'
import { GitBranch as UiGitBranch, Home as UiHome, Settings as UiSettings, X as UiX } from '@lucide/vue'
import {
  TabsList as UiTabsList,
  TabsTrigger as UiTabsTrigger
} from '@/components/ui/tabs'
import ToolIcon from './tool-icon.vue'

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
  <ui-tabs-list
    class="w-full justify-start gap-1 overflow-x-auto h-10 rounded-none border-b bg-muted"
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
</template>
