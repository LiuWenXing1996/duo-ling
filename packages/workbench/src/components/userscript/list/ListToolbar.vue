<script setup lang="ts">
// 用户脚本列表的固定工具栏（不随列表滚动）：搜索 / 状态筛选 / 排序 / 批量操作 + 刷新 / 导入 /
// 新建分组 / 添加脚本。本组件只负责展示与转发动作，全部写操作回传父级（列表壳）执行。
// 作用于全部脚本的动线收在左侧「批量」菜单里（启停 / 导出 / 删除），不在页面上另开第二个「全部」入口。
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
  /** 脚本总数（管理工具段是否渲染 + 全部导出 / 删除的计数文案） */
  scriptsCount: number
  /** 搜索关键词（v-model:query） */
  query: string
  /** 状态筛选 chips（带计数） */
  statusFilters: StatusFilterEntry[]
  /** 当前状态筛选（v-model:statusFilter） */
  statusFilter: StatusFilter
  /** 排序键（v-model:sortKey） */
  sortKey: SortKey
  /** 已启用脚本数（批量菜单禁用判断 + chips 计数） */
  enabledCount: number
  /** 列表加载中：刷新按钮转圈 */
  loading: boolean
  /** 批量启停进行中：批量入口置灰 */
  batchToggling: boolean
  /** 导出进行中：全部导出置灰 */
  exporting: boolean
  /** 全部删除进行中：全部删除置灰 */
  removingAll: boolean
  /** 导入进行中：导入入口置灰 + 转圈 */
  importing: boolean
  /** 创建进行中：添加脚本置灰 + 转圈 */
  creating: boolean
}>()

const emit = defineEmits<{
  'update:query': [v: string]
  'update:statusFilter': [v: StatusFilter]
  'update:sortKey': [v: SortKey]
  /** 刷新列表 */
  refresh: []
  /** 批量启停（作用于全部脚本） */
  toggleAll: [next: boolean]
  /** 开「全部导出」确认弹窗 */
  exportAll: []
  /** 开「全部删除」确认弹窗 */
  removeAll: []
  /** 点开隐藏的 zip 文件选择器（选择器本体在父级） */
  pickFile: []
  /** 打开「从路径导入」弹窗 */
  openPathImport: []
  /** 打开「粘贴导入」弹窗 */
  openPasteImport: []
  /** 打开「从链接导入」弹窗 */
  openLinkImport: []
  /** 打开「新建分组」弹窗 */
  createGroup: []
  /** 零输入新建脚本 */
  create: []
}>()

// 双向绑定经 computed 中转：prop 只读，setter 转发 update 事件（类型一并收口）。
const queryModel = computed({ get: () => props.query, set: (v) => emit('update:query', v) })
const statusModel = computed({
  get: () => props.statusFilter,
  set: (v) => emit('update:statusFilter', v),
})
const sortModel = computed({ get: () => props.sortKey, set: (v) => emit('update:sortKey', v) })
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-2 gap-y-2">
    <!-- 搜索 / 筛选 / 排序 / 批量：管理工具，没有脚本时整段隐藏 -->
    <template v-if="scriptsCount">
      <!-- 搜索：按名称 / 匹配规则；有关键词时显示一键清空 -->
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

      <!-- 状态筛选 chips：带计数，点击切换 -->
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

      <!-- 排序 -->
      <ui-select v-model="sortModel">
        <ui-select-trigger class="h-7 w-[104px] text-xs" aria-label="排序方式">
          <ui-select-value />
        </ui-select-trigger>
        <ui-select-content>
          <ui-select-item value="savedAt">按更新时间</ui-select-item>
          <ui-select-item value="name">按名称</ui-select-item>
        </ui-select-content>
      </ui-select>

      <!-- 批量操作：作用于全部脚本的动线收在这一个菜单里（启停 / 导出 / 删除），
           不在页面上另开第二个「全部」入口。启停循环复用单条 toggle、逐条容错；
           导出与删除都先过各自的确认弹窗（隐私提示与不可撤销提示在弹窗里，只写一处）。 -->
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

    <!-- 右侧操作：刷新 / 导入 / 新建分组 / 添加脚本（作用于全部脚本的动线在左侧「批量」菜单里） -->
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
      <!-- 导入：四种取内容方式（文件选择器 / 手输本地路径 / 粘贴源码 / 从链接获取），拿到内容之后链路完全共用。
           触发按钮用原生 title、不套 Tooltip —— Tooltip 与 DropdownMenuTrigger 不能叠
           （menu popper 会失去定位，见 AGENTS.md 的 UI 复用约束）。 -->
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
      <!-- 新建分组：打开命名弹窗（空字符串 = 未分组，永不删） -->
      <ui-button
        size="sm"
        class="h-7 gap-1 px-2.5 text-xs"
        title="新建分组"
        @click="emit('createGroup')"
      >
        <ui-folder-plus class="size-3.5" />
        新建分组
      </ui-button>
      <!-- 添加脚本：零输入创建（自动命名 + 初始模板 + 建 git 仓 + 启用） -->
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
