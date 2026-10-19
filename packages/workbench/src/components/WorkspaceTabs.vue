<script setup lang="ts">
// 工作区标签栏：按标签种类配图标（未单独列出的种类落兜底图标），标题取自标签自身。基础标签（脚本列表）不可关闭。
// 构建信息（页面 / SW 分支 + 时刻）不在这里展示：已移入 设置 → 关于，与版本号同处一地更好找，
// 顶栏只留标签本身。取数实现见 `@duoling/shared` 的 app/build-info。
import type { WorkspaceTab } from '../types/tab'
import {
  BookOpen as UiBookOpen,
  Clock as UiClock,
  Code as UiCode,
  Compass as UiCompass,
  FolderTree as UiFolderTree,
  List as UiList,
  MessagesSquare as UiMessagesSquare,
  Pencil as UiPencil,
  Settings as UiSettings,
  Wrench as UiWrench,
  X as UiX,
} from '@lucide/vue'
import {
  TabsList as UiTabsList,
  TabsTrigger as UiTabsTrigger,
} from '@duoling/ui/components/ui/tabs'

const props = defineProps<{
  tabs: WorkspaceTab[]
  activeId: string
  /** 基础标签 id：始终存在、不可关闭（当前为脚本列表） */
  pinnedTabId: string
  /** 有未保存改动的标签 id：这些标签标题后点一颗红点——切走后也能一眼看出哪个编辑器还有草稿 */
  dirtyTabIds?: string[]
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
        <ui-list
          v-if="tab.kind === 'userscript-list'"
          class="size-3.5 shrink-0"
          :class="tab.id === props.activeId ? 'text-primary' : ''"
        />
        <ui-pencil
          v-else-if="tab.kind === 'userscript-edit'"
          class="size-3.5 shrink-0"
          :class="tab.id === props.activeId ? 'text-primary' : ''"
        />
        <ui-compass
          v-else-if="tab.kind === 'guide'"
          class="size-3.5 shrink-0"
          :class="tab.id === props.activeId ? 'text-primary' : ''"
        />
        <ui-wrench
          v-else-if="tab.kind === 'agent-tools'"
          class="size-3.5 shrink-0"
          :class="tab.id === props.activeId ? 'text-primary' : ''"
        />
        <ui-code
          v-else-if="tab.kind === 'gm-api'"
          class="size-3.5 shrink-0"
          :class="tab.id === props.activeId ? 'text-primary' : ''"
        />
        <ui-messages-square
          v-else-if="tab.kind === 'session-history'"
          class="size-3.5 shrink-0"
          :class="tab.id === props.activeId ? 'text-primary' : ''"
        />
        <ui-clock
          v-else-if="tab.kind === 'tab-activity'"
          class="size-3.5 shrink-0"
          :class="tab.id === props.activeId ? 'text-primary' : ''"
        />
        <!-- 文件管理：整库文件树，用目录树图标；不给它的话会落到兜底的齿轮，看着像「设置」 -->
        <ui-folder-tree
          v-else-if="tab.kind === 'lfs-browser'"
          class="size-3.5 shrink-0"
          :class="tab.id === props.activeId ? 'text-primary' : ''"
        />
        <ui-book-open
          v-else-if="tab.kind === 'help'"
          class="size-3.5 shrink-0"
          :class="tab.id === props.activeId ? 'text-primary' : ''"
        />
        <ui-settings
          v-else
          class="size-3.5 shrink-0"
          :class="tab.id === props.activeId ? 'text-primary' : ''"
        />
        <!--
          未保存标记：夹在图标与标题之间，**不紧贴标题** —— 紧贴时不管什么颜色都会被读成名字的一部分
          （像名字里混进了个字符）；颜色用 --unsaved（专用语义色，见 main.css）：整套 token 都是无彩色
          （primary 就是黑/白，与文字同色等于看不见），错误红留给「已在别处修改」那类真警告。
        -->
        <span
          v-if="props.dirtyTabIds?.includes(tab.id)"
          class="size-1.5 shrink-0 rounded-full bg-unsaved"
          role="img"
          aria-label="有未保存改动"
        />
        <span class="truncate">{{ tab.title }}</span>
        <button
          v-if="tab.id !== props.pinnedTabId"
          class="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
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
