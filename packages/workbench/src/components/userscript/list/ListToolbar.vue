<script setup lang="ts">
// 固定区工具栏：搜索 / 筛选 / 排序 / 批量 / 刷新 / 导入 / 新建
import { computed } from 'vue'
import {
  ChevronDown as UiChevronDown,
  ClipboardPaste as UiClipboardPaste,
  FolderInput as UiFolderInput,
  FolderPlus as UiFolderPlus,
  Link as UiLink,
  ListFilter as UiListFilter,
  LoaderCircle as UiLoaderCircle,
  Plus as UiPlus,
  RefreshCw as UiRefreshCw,
  Search as UiSearch,
  Upload as UiUpload,
  X as UiX,
} from '@lucide/vue'
import { Button as UiButton } from '@duoling/ui/components/ui/button'
import {
  DropdownMenu as UiDropdownMenu,
  DropdownMenuContent as UiDropdownMenuContent,
  DropdownMenuItem as UiDropdownMenuItem,
  DropdownMenuSeparator as UiDropdownMenuSeparator,
  DropdownMenuTrigger as UiDropdownMenuTrigger,
} from '@duoling/ui/components/ui/dropdown-menu'
import { Input as UiInput } from '@duoling/ui/components/ui/input'
import {
  Select as UiSelect,
  SelectContent as UiSelectContent,
  SelectItem as UiSelectItem,
  SelectTrigger as UiSelectTrigger,
  SelectValue as UiSelectValue,
} from '@duoling/ui/components/ui/select'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger,
} from '@duoling/ui/components/ui/tooltip'
import type { SortKey, StatusFilter, StatusFilterEntry } from './use-filters'

const props = defineProps<{
  scriptsCount: number
  query: string
  statusFilters: StatusFilterEntry[]
  statusFilter: StatusFilter
  sortKey: SortKey
  enabledCount: number
  loading: boolean
  batchToggling: boolean
  exporting: boolean
  removingAll: boolean
  importing: boolean
  creating: boolean
}>()

const emit = defineEmits<{
  'update:query': [v: string]
  'update:statusFilter': [v: StatusFilter]
  'update:sortKey': [v: SortKey]
  refresh: []
  toggleAll: [next: boolean]
  exportAll: []
  removeAll: []
  pickFile: []
  openPathImport: []
  openPasteImport: []
  openLinkImport: []
  createGroup: []
  create: []
}>()

const queryModel = computed({ get: () => props.query, set: (v) => emit('update:query', v) })
const statusModel = computed({
  get: () => props.statusFilter,
  set: (v) => emit('update:statusFilter', v),
})
const sortModel = computed({ get: () => props.sortKey, set: (v) => emit('update:sortKey', v) })
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-2 gap-y-2">
    <template v-if="scriptsCount">
      <div class="relative min-w-0 flex-1 basis-48">
        <ui-search
          class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <ui-input
          v-model="queryModel"
          placeholder="搜索名称或匹配规则…"
          class="h-7 pr-7 pl-8 text-xs"
        />
        <button
          v-if="query"
          type="button"
          class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="清空搜索"
          @click="queryModel = ''"
        >
          <ui-x class="size-3.5" />
        </button>
      </div>

      <div class="flex items-center gap-1" role="group" aria-label="按状态筛选">
        <button
          v-for="f in statusFilters"
          :key="f.key"
          type="button"
          class="h-7 rounded-full px-2.5 text-xs transition-colors"
          :class="
            statusFilter === f.key
              ? 'bg-primary/10 font-medium text-primary'
              : 'text-muted-foreground hover:bg-muted'
          "
          :aria-pressed="statusFilter === f.key"
          @click="statusModel = f.key"
        >
          {{ f.label }}
          <span class="ml-0.5 tabular-nums opacity-70">{{ f.count }}</span>
        </button>
      </div>

      <ui-select v-model="sortModel">
        <ui-select-trigger class="h-7 w-[104px] text-xs" aria-label="排序方式">
          <ui-select-value />
        </ui-select-trigger>
        <ui-select-content>
          <ui-select-item value="savedAt">按更新时间</ui-select-item>
          <ui-select-item value="name">按名称</ui-select-item>
        </ui-select-content>
      </ui-select>

      <ui-dropdown-menu>
        <ui-dropdown-menu-trigger as-child>
          <ui-button
            variant="ghost"
            size="sm"
            class="h-7 gap-1 px-2.5 text-xs"
            title="批量操作（作用于全部脚本）"
            :disabled="batchToggling"
          >
            <ui-loader-circle v-if="batchToggling" class="size-3.5 animate-spin" />
            <ui-list-filter v-else class="size-3.5" />
            批量
            <ui-chevron-down class="size-3 opacity-60" />
          </ui-button>
        </ui-dropdown-menu-trigger>
        <ui-dropdown-menu-content align="end" class="w-40">
          <ui-dropdown-menu-item :disabled="!enabledCount" @click="emit('toggleAll', false)">
            全部停用
          </ui-dropdown-menu-item>
          <ui-dropdown-menu-item
            :disabled="enabledCount === scriptsCount"
            @click="emit('toggleAll', true)"
          >
            全部启用
          </ui-dropdown-menu-item>
          <ui-dropdown-menu-separator />
          <ui-dropdown-menu-item :disabled="exporting" @click="emit('exportAll')">
            全部导出
          </ui-dropdown-menu-item>
          <ui-dropdown-menu-item
            :disabled="removingAll"
            class="text-destructive focus:text-destructive"
            @click="emit('removeAll')"
          >
            全部删除
          </ui-dropdown-menu-item>
        </ui-dropdown-menu-content>
      </ui-dropdown-menu>
    </template>

    <div class="ms-auto flex shrink-0 items-center gap-1">
      <ui-tooltip-provider>
        <ui-tooltip>
          <ui-tooltip-trigger as-child>
            <ui-button
              variant="ghost"
              size="icon"
              class="size-7"
              aria-label="刷新列表"
              :disabled="loading"
              @click="emit('refresh')"
            >
              <ui-refresh-cw class="size-3.5" :class="{ 'animate-spin': loading }" />
            </ui-button>
          </ui-tooltip-trigger>
          <ui-tooltip-content>刷新列表</ui-tooltip-content>
        </ui-tooltip>
      </ui-tooltip-provider>
      <ui-dropdown-menu>
        <ui-dropdown-menu-trigger as-child>
          <ui-button
            variant="ghost"
            size="sm"
            class="h-7 gap-1 px-2.5 text-xs"
            title="导入脚本（文件、路径、源码或链接）"
            :disabled="importing"
          >
            <ui-loader-circle v-if="importing" class="size-3.5 animate-spin" />
            <ui-upload v-else class="size-3.5" />
            导入
            <ui-chevron-down class="size-3 opacity-60" />
          </ui-button>
        </ui-dropdown-menu-trigger>
        <ui-dropdown-menu-content align="end" class="w-48">
          <ui-dropdown-menu-item @click="emit('pickFile')">
            <ui-upload class="size-3.5" />
            选择 zip 文件…
          </ui-dropdown-menu-item>
          <ui-dropdown-menu-item @click="emit('openPathImport')">
            <ui-folder-input class="size-3.5" />
            输入文件路径…
          </ui-dropdown-menu-item>
          <ui-dropdown-menu-item @click="emit('openPasteImport')">
            <ui-clipboard-paste class="size-3.5" />
            粘贴脚本代码…
          </ui-dropdown-menu-item>
          <ui-dropdown-menu-item @click="emit('openLinkImport')">
            <ui-link class="size-3.5" />
            从链接导入…
          </ui-dropdown-menu-item>
        </ui-dropdown-menu-content>
      </ui-dropdown-menu>
      <ui-button
        size="sm"
        class="h-7 gap-1 px-2.5 text-xs"
        title="新建分组"
        @click="emit('createGroup')"
      >
        <ui-folder-plus class="size-3.5" />
        新建分组
      </ui-button>
      <ui-button
        size="sm"
        class="h-7 gap-1 px-2.5 text-xs"
        title="添加脚本"
        :disabled="creating"
        @click="emit('create')"
      >
        <ui-loader-circle v-if="creating" class="size-3.5 animate-spin" />
        <ui-plus v-else class="size-3.5" />
        添加脚本
      </ui-button>
    </div>
  </div>
</template>
