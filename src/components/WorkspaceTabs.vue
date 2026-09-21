<script setup lang="ts">
// 工作区标签栏：设置 / 开发者 / AI 界面对话预览 / 脚本列表 / 脚本编辑器 / AI 工具 / GM API。基础标签（脚本列表）不可关闭。
// 构建信息（页面 / SW 分支 + 时刻）不在这里展示：已移入 设置 → 关于，与版本号同处一地更好找，
// 顶栏只留标签本身。取数实现见 src/lib/build-info.ts。
import type { WorkspaceTab } from '@/types/tab'
import {
  Code as UiCode,
  History as UiHistory,
  Compass as UiCompass,
  List as UiList,
  MessagesSquare as UiMessagesSquare,
  Pencil as UiPencil,
  Settings as UiSettings,
  Wrench as UiWrench,
  X as UiX
} from '@lucide/vue'
import {
  TabsList as UiTabsList,
  TabsTrigger as UiTabsTrigger
} from '@/components/ui/tabs'

const props = defineProps<{
  tabs: WorkspaceTab[]
  activeId: string
  /** 基础标签 id：始终存在、不可关闭（当前为脚本列表） */
  pinnedTabId: string
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
        <ui-list v-if="tab.kind === 'userscript-list'" class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <ui-history v-else-if="tab.kind === 'error-log'" class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <ui-pencil v-else-if="tab.kind === 'userscript-edit'" class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <ui-compass v-else-if="tab.kind === 'guide'" class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <ui-wrench v-else-if="tab.kind === 'agent-tools'" class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <ui-code v-else-if="tab.kind === 'gm-api'" class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <ui-messages-square v-else-if="tab.kind === 'session-history'" class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <ui-settings v-else class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <span class="truncate">{{ tab.title }}</span>
        <button
          v-if="tab.id !== props.pinnedTabId"
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
