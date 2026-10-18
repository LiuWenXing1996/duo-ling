<script setup lang="ts">
// 用户脚本列表标签页：脚本管理的唯一入口 —— 列表 + 启停 + 零输入新建 + 可用性横幅。
// 错误日志是历史信息，在「活动历史」面板里按页看（左侧导航进入），本页不展示任何脚本报错
// —— 环境级问题仅靠下方 availability 横幅兜底。
//
// 数据通道：userscriptClient。workbench 是可信扩展页，可直接发 runtime 消息，
// 因此不依赖全局中间层，直接经 lib/userscripts/ui-client.ts 发命令。
//
// 本文件是壳：布局 + 各域组装 + 单脚本删除 / 重命名弹窗。数据与操作按域拆在 ./list/ 下：
// use-script-list（数据面）/ use-filters（搜索筛选排序）/ use-groups（分组）/
// use-transfer（出入库）/ use-script-actions（单脚本操作）+ ListToolbar / ScriptCard /
// TransferDialogs / GroupDialogs 子组件。
import { onMounted, onUnmounted, ref, toRef } from 'vue'
import {
  AlertTriangle as UiAlertTriangle,
  ChevronDown as UiChevronDown,
  ChevronRight as UiChevronRight,
  ChevronUp as UiChevronUp,
  Pencil as UiPencil
} from '@lucide/vue'
import { Button as UiButton } from '@duoling/ui/components/ui/button'
import {
  Dialog as UiDialog,
  DialogContent as UiDialogContent,
  DialogDescription as UiDialogDescription,
  DialogFooter as UiDialogFooter,
  DialogTitle as UiDialogTitle
} from '@duoling/ui/components/ui/dialog'
import {
  DropdownMenu as UiDropdownMenu,
  DropdownMenuContent as UiDropdownMenuContent,
  DropdownMenuItem as UiDropdownMenuItem,
  DropdownMenuTrigger as UiDropdownMenuTrigger
} from '@duoling/ui/components/ui/dropdown-menu'
import { Input as UiInput } from '@duoling/ui/components/ui/input'
import { subscribeAvailability } from '@duoling/ui/lib/userscripts/ui-client'
import ListToolbar from './list/ListToolbar.vue'
import ScriptCard from './list/ScriptCard.vue'
import TransferDialogs from './list/TransferDialogs.vue'
import GroupDialogs from './list/GroupDialogs.vue'
import { useScriptList } from './list/use-script-list'
import { useScriptFilters } from './list/use-filters'
import { useGroups } from './list/use-groups'
import { useTransfer } from './list/use-transfer'
import { useScriptActions } from './list/use-script-actions'

const props = defineProps<{
  /** 编辑器里有未保存改动的脚本 uuid（宿主注入）：删除前据此示警草稿会一起没 */
  dirtyUuids?: string[]
}>()

const emit = defineEmits<{
  /** 请求打开该脚本的编辑器标签页（由 WorkspaceHost 接管） */
  edit: [uuid: string, title: string]
  /** 脚本删除后：宿主据此关掉它的编辑器标签（项目已不存在） */
  deleted: [uuid: string]
  /** 需要开权限（横幅）：请宿主切到引导标签页 */
  openGuide: []
}>()

// 组装顺序即依赖顺序：数据面 → 过滤（依赖 scripts）→ 分组（依赖 visibleScripts）
// → 出入库（依赖 refresh / justImported / error）→ 单脚本操作（依赖 scripts / refresh 等）。
// toRef 从 reactive 束里取底层 ref 传给依赖方（束的属性访问会解包，取不到 ref 本体）。
const sl = useScriptList()
const f = useScriptFilters(toRef(sl, 'scripts'))
const g = useGroups({ visibleScripts: toRef(f, 'visibleScripts'), error: toRef(sl, 'error') })
const tr = useTransfer({
  refresh: sl.refresh,
  justImported: toRef(sl, 'justImported'),
  error: toRef(sl, 'error'),
  onOpenGuide: () => emit('openGuide'),
})
const a = useScriptActions({
  scripts: toRef(sl, 'scripts'),
  error: toRef(sl, 'error'),
  refresh: sl.refresh,
  justCreated: toRef(sl, 'justCreated'),
  onDeleted: (uuid) => emit('deleted', uuid),
  onEdit: (uuid, title) => emit('edit', uuid, title),
})

/** 隐藏的 zip 文件选择器（file picker）：工具栏「选择 zip 文件…」经 pickFile 事件触发它 */
const importInput = ref<HTMLInputElement | null>(null)

let unsubscribeAvailability: (() => void) | null = null

onMounted(() => {
  void sl.refresh()
  void g.refreshGroups()
  void sl.detectAvailability()
  // 可用性变化由 SW 广播（availabilityChanged），横幅被动更新，不自己盯 visibilitychange
  unsubscribeAvailability = subscribeAvailability((av) => (sl.availability = av))
})

onUnmounted(() => {
  unsubscribeAvailability?.()
})
</script>

<template>
  <section class="panel">
    <!-- 固定区：单行工具栏不随列表滚动 —— 搜索 / 筛选 / 排序 / 批量操作 + 刷新 / 导入 / 新建，列表再长入口也始终可见 -->
    <div class="mx-auto w-full max-w-6xl shrink-0 px-5 pt-4">
      <ListToolbar
        :scripts-count="sl.scripts.length"
        :query="f.query"
        :status-filters="f.statusFilters"
        :status-filter="f.statusFilter"
        :sort-key="f.sortKey"
        :enabled-count="f.enabledCount"
        :loading="sl.loading"
        :batch-toggling="sl.batchToggling"
        :exporting="tr.exporting"
        :removing-all="a.removingAll"
        :importing="tr.importing"
        :creating="sl.creating"
        @update:query="f.query = $event"
        @update:status-filter="f.statusFilter = $event"
        @update:sort-key="f.sortKey = $event"
        @refresh="sl.refresh()"
        @toggle-all="sl.onToggleAll"
        @export-all="tr.askExportAll"
        @remove-all="a.removeAllOpen = true"
        @pick-file="importInput?.click()"
        @open-path-import="tr.openPathImport"
        @open-paste-import="tr.openPasteImport"
        @open-link-import="tr.openLinkImport"
        @create-group="g.openCreateGroup"
        @create="sl.onCreate"
      />
    </div>

    <!-- 滚动区：横幅 / 提示 / 脚本列表，只有这里滚 -->
    <div class="min-h-0 flex-1 overflow-y-auto scroll-gap px-5 pb-5">
      <div class="mx-auto max-w-6xl space-y-3 pt-1">

        <!-- 可用性横幅：仅在引擎不可用时显示（有需要用户行动的信息才占位）；单行紧凑排版 -->
        <div
          v-if="sl.availability && !sl.availability.available"
          class="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs"
        >
          <ui-alert-triangle class="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span class="shrink-0 font-medium text-amber-600 dark:text-amber-400">用户脚本功能不可用</span>
          <p class="min-w-0 flex-1 truncate text-muted-foreground" :title="sl.availability.guideText">
            {{ sl.availability.guideText }}
          </p>
          <!-- 引导入口：完整步骤与「打开扩展管理页」按钮都在引导标签页，本页只留一句提示 -->
          <ui-button
            type="button"
            variant="outline"
            size="xs"
            class="shrink-0"
            data-testid="open-guide"
            @click="emit('openGuide')"
          >
            查看开启引导
          </ui-button>
        </div>

        <p
          v-if="sl.error"
          class="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive"
        >
          {{ sl.error }}
        </p>

        <p
          v-if="sl.loading && !sl.scripts.length"
          class="py-10 text-center text-xs text-muted-foreground"
        >
          加载中…
        </p>
        <p v-else-if="!sl.scripts.length" class="py-10 text-center text-xs text-muted-foreground">
          还没有用户脚本。可点上方「添加脚本」新建，也可在对话界面让 AI 生成。
        </p>
        <!-- 有脚本但被搜索 / 筛选滤空：提示调整条件，而非误导为「没有脚本」 -->
        <p
          v-else-if="!f.visibleScripts.length"
          class="py-10 text-center text-xs text-muted-foreground"
        >
          没有匹配的脚本。试试调整搜索关键词或筛选条件。
        </p>

        <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
          <template
            v-for="item in g.viewItems"
            :key="item.kind === 'header' ? 'h-' + item.id : item.s.uuid"
          >
            <!-- 分组头：点击折叠 / 展开；真实分组带重排与操作菜单，未分组只有折叠 -->
            <div
              v-if="item.kind === 'header'"
              class="col-span-full flex items-center gap-1 pt-2"
            >
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                data-testid="group-header"
                :aria-expanded="!g.collapsed[item.id]"
                @click="g.toggleCollapse(item.id)"
              >
                <ui-chevron-right v-if="g.collapsed[item.id]" class="size-3.5 shrink-0 text-muted-foreground" />
                <ui-chevron-down v-else class="size-3.5 shrink-0 text-muted-foreground" />
                <span class="truncate text-xs font-medium">{{ item.name }}</span>
                <span class="shrink-0 text-[10px] tabular-nums text-muted-foreground">{{ item.count }}</span>
              </button>
              <template v-if="item.id !== g.UNGROUPED_KEY">
                <ui-button
                  variant="ghost"
                  size="icon"
                  class="size-6"
                  title="上移分组"
                  :disabled="item.id === g.firstGroupId"
                  @click="g.reorderGroup(item.id, -1)"
                >
                  <ui-chevron-up class="size-3.5" />
                </ui-button>
                <ui-button
                  variant="ghost"
                  size="icon"
                  class="size-6"
                  title="下移分组"
                  :disabled="item.id === g.lastGroupId"
                  @click="g.reorderGroup(item.id, 1)"
                >
                  <ui-chevron-down class="size-3.5" />
                </ui-button>
                <ui-dropdown-menu>
                  <ui-dropdown-menu-trigger as-child>
                    <ui-button
                      variant="ghost"
                      size="icon"
                      class="size-6"
                      title="分组操作"
                    >
                      <ui-pencil class="size-3.5" />
                    </ui-button>
                  </ui-dropdown-menu-trigger>
                  <ui-dropdown-menu-content align="end">
                    <ui-dropdown-menu-item @click="g.openRenameGroup(item.id, item.name)">
                      重命名分组
                    </ui-dropdown-menu-item>
                    <ui-dropdown-menu-item
                      class="text-destructive focus:text-destructive"
                      @click="g.askRemoveGroup(item.id)"
                    >
                      删除分组
                    </ui-dropdown-menu-item>
                  </ui-dropdown-menu-content>
                </ui-dropdown-menu>
              </template>
            </div>

            <!-- 脚本卡片（网格单元；s = item.s） -->
            <ScriptCard
              v-else
              :s="item.s"
              :toggling="sl.toggling === item.s.uuid"
              :removing="a.removing === item.s.uuid"
              :just-created="sl.justCreated.includes(item.s.uuid)"
              :just-imported-badge="sl.justImported.includes(item.s.uuid)"
              :saving="!!sl.buildPhase[item.s.uuid]"
              :exporting="tr.exporting"
              :copied="a.copiedId === item.s.uuid"
              @toggle="(v: boolean) => sl.onToggle(item.s, v)"
              @edit="a.openEditor(item.s)"
              @rename="a.askRename(item.s)"
              @move="g.moveTarget = item.s"
              @export="tr.askExportSingle(item.s)"
              @remove="a.askRemove(item.s)"
              @copy-id="a.copyScriptId(item.s.uuid)"
            />
          </template>
        </div>

        <!--
          扩展内置件（只读）：扩展自己注进页面的能力管道，与用户脚本分开列 —— 它们没有源码 /
          启停 / 删除，上面的网格操作对它们一律不适用。状态随「启用脚本并集」「记录开关」与引擎
          可用性变化，故跟着列表同一遍回拉。
        -->
        <div
          v-if="sl.builtins.length"
          class="mt-4 border-t border-border pt-3"
          data-testid="builtin-scripts-section"
        >
          <div class="flex items-baseline gap-2">
            <span class="text-xs font-medium">扩展内置件</span>
            <span class="text-[11px] text-muted-foreground">随扩展分发，不由你启停</span>
          </div>
          <div class="mt-2 flex flex-col gap-1.5">
            <div
              v-for="b in sl.builtins"
              :key="b.id"
              class="rounded-md border border-dashed border-border px-3 py-2"
              data-testid="builtin-script-row"
            >
              <div class="flex items-center gap-2">
                <span class="min-w-0 truncate text-xs font-medium">{{ b.name }}</span>
                <span class="shrink-0 text-[10px] text-muted-foreground">{{ b.world }}</span>
                <span class="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {{ b.registered ? '已注册' : '未注册' }}
                </span>
              </div>
              <p class="mt-0.5 text-[11px] text-muted-foreground">{{ b.note }}</p>
              <p
                v-if="b.matches.length"
                class="mt-0.5 truncate text-[11px] text-muted-foreground"
                :title="b.matches.join(' ')"
              >
                {{ b.matches.join(' ') }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 全部删除确认弹窗：破坏性操作，明示条数与「不可撤销」，并说清不受影响的范围 -->
    <ui-dialog
      :open="a.removeAllOpen"
      @update:open="(v: boolean) => { if (!v) a.removeAllOpen = false }"
    >
      <ui-dialog-content class="max-w-md">
        <ui-dialog-title class="text-base font-semibold">删除全部脚本</ui-dialog-title>
        <ui-dialog-description class="text-sm text-muted-foreground">
          确定删除全部 {{ sl.scripts.length }} 个脚本吗？各自的历史版本会一并删除。
          <span class="mt-2 block text-destructive">此操作不可撤销。</span>
        </ui-dialog-description>
        <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
          <ui-button variant="ghost" size="sm" @click="a.removeAllOpen = false">取消</ui-button>
          <ui-button
            variant="destructive"
            size="sm"
            :disabled="a.removingAll"
            @click="a.confirmRemoveAll"
          >
            删除全部
          </ui-button>
        </ui-dialog-footer>
      </ui-dialog-content>
    </ui-dialog>

    <!-- 重命名弹窗：名字是管理面标识，改它不动源码、不产生版本 -->
    <ui-dialog
      :open="!!a.renameTarget"
      @update:open="(v: boolean) => { if (!v) a.renameTarget = null }"
    >
      <ui-dialog-content class="max-w-md">
        <ui-dialog-title class="text-base font-semibold">重命名脚本</ui-dialog-title>
        <ui-dialog-description class="text-sm text-muted-foreground">
          只改列表里显示的名字：脚本源码、匹配规则与版本历史都不受影响。
        </ui-dialog-description>
        <div class="mt-3">
          <ui-input
            v-model="a.renameName"
            placeholder="脚本名称"
            aria-label="脚本名称"
            spellcheck="false"
            autocomplete="off"
            :disabled="a.renaming"
            @keydown.enter="a.confirmRename"
          />
        </div>
        <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
          <ui-button variant="ghost" size="sm" @click="a.renameTarget = null">取消</ui-button>
          <ui-button
            size="sm"
            :disabled="a.renaming || !a.renameName.trim()"
            @click="a.confirmRename"
          >
            {{ a.renaming ? '重命名中…' : '重命名' }}
          </ui-button>
        </ui-dialog-footer>
      </ui-dialog-content>
    </ui-dialog>

    <!-- 删除确认弹窗：用 UI 弹窗替代原生 confirm（原生 confirm / prompt 是同步阻塞的，会冻结渲染） -->
    <ui-dialog
      :open="!!a.pendingRemove"
      @update:open="(v: boolean) => { if (!v) a.pendingRemove = null }"
    >
      <ui-dialog-content class="max-w-md">
        <ui-dialog-title class="text-base font-semibold">删除脚本</ui-dialog-title>
        <ui-dialog-description class="text-sm text-muted-foreground">
          确定删除脚本「{{ a.pendingRemove?.name }}」吗？此操作不可撤销，其历史版本会一并删除。
          <span
            v-if="a.pendingRemove && props.dirtyUuids?.includes(a.pendingRemove.uuid)"
            class="mt-2 block text-destructive"
          >
            该脚本的编辑器里还有未保存的改动，删除后会一起丢失。
          </span>
        </ui-dialog-description>
        <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
          <ui-button variant="ghost" size="sm" @click="a.pendingRemove = null">取消</ui-button>
          <ui-button
            variant="destructive"
            size="sm"
            :disabled="a.removing !== null"
            @click="a.confirmRemove"
          >
            删除
          </ui-button>
        </ui-dialog-footer>
      </ui-dialog-content>
    </ui-dialog>

    <!-- 出入库弹窗（导出确认 / 路径导入 / 粘贴导入 / 链接导入 / 汇总报告） -->
    <TransferDialogs :t="tr" :scripts-count="sl.scripts.length" />
    <!-- 分组弹窗（新建 / 重命名 / 删除确认 / 移动到分组） -->
    <GroupDialogs :g="g" />

    <input
      ref="importInput"
      type="file"
      accept=".zip,application/zip"
      class="hidden"
      @change="tr.onImportFile"
    >
  </section>
</template>
