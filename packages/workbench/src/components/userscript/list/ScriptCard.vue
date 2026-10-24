<script setup lang="ts">
// 列表行：启停开关、状态标与单行操作入口
import {
  Braces as UiBraces,
  Check as UiCheck,
  Copy as UiCopy,
  Download as UiDownload,
  FolderSymlink as UiFolderSymlink,
  LoaderCircle as UiLoaderCircle,
  Pencil as UiPencil,
  Tag as UiTag,
  Trash2 as UiTrash2,
} from '@lucide/vue'
import { Button as UiButton } from '@duoling/ui/components/ui/button'
import { Switch as UiSwitch, SwitchThumb as UiSwitchThumb } from '@duoling/ui/components/ui/switch'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger,
} from '@duoling/ui/components/ui/tooltip'
import { formatTimestamp } from '@duoling/ui/lib/format'
import type { ScriptSummary } from '@duoling/shared'

defineProps<{
  s: ScriptSummary
  toggling: boolean
  removing: boolean
  justCreated: boolean
  justImportedBadge: boolean
  saving: boolean
  exporting: boolean
  copied: boolean
}>()

const emit = defineEmits<{
  toggle: [next: boolean]
  edit: []
  rename: []
  move: []
  export: []
  remove: []
  copyId: []
}>()

function timeLabel(ts: number): string {
  return ts ? formatTimestamp(Math.floor(ts / 1000)) : ''
}
</script>

<template>
  <div class="flex flex-col rounded-md border bg-card p-3">
    <div class="flex items-start gap-2">
      <span
        class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
      >
        <ui-braces class="size-3.5" />
      </span>
      <div class="min-w-0 flex-1">
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <span class="block truncate text-sm font-medium">{{ s.name }}</span>
            </ui-tooltip-trigger>
            <ui-tooltip-content>{{ s.name }}</ui-tooltip-content>
          </ui-tooltip>
          <div class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span
              v-if="justImportedBadge && !s.enabled"
              class="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
            >
              刚导入 · 未启用
            </span>
            <span
              v-else-if="justCreated"
              class="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
            >
              刚新建
            </span>
            <span
              v-if="saving"
              class="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
            >
              <ui-loader-circle class="size-3 animate-spin" />
              保存中
            </span>
            <button
              type="button"
              class="flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted"
              :title="`复制完整脚本 ID（发给 AI 可定位脚本）：${s.uuid}`"
              :aria-label="`复制「${s.name}」的脚本 ID`"
              @click="emit('copyId')"
            >
              <ui-check v-if="copied" class="size-3 text-green-600" />
              <ui-copy v-else class="size-3" />
              {{ s.uuid.slice(0, 8) }}
            </button>
          </div>
        </ui-tooltip-provider>
      </div>
    </div>

    <p class="mt-2 truncate text-xs text-muted-foreground">
      匹配规则：<span class="font-mono">{{ s.matches.join(', ') || '无' }}</span>
    </p>
    <div class="mb-3 mt-1 space-y-0.5 text-xs text-muted-foreground tabular-nums">
      <p>更新时间：{{ timeLabel(s.savedAt) || '无' }}</p>
    </div>

    <div class="mt-auto flex items-center justify-between gap-2 border-t pt-2.5">
      <ui-switch
        :model-value="s.enabled"
        :disabled="toggling"
        :aria-label="`${s.name}：${s.enabled ? '已启用' : '已停用'}`"
        @update:model-value="(v: boolean) => emit('toggle', v)"
      >
        <ui-switch-thumb />
      </ui-switch>
      <div class="flex items-center gap-1">
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <ui-button
                variant="ghost"
                size="icon"
                class="size-6"
                aria-label="编辑脚本"
                @click="emit('edit')"
              >
                <ui-pencil class="size-3.5" />
              </ui-button>
            </ui-tooltip-trigger>
            <ui-tooltip-content>编辑脚本</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <ui-button
                variant="ghost"
                size="icon"
                class="size-6"
                aria-label="重命名脚本"
                @click="emit('rename')"
              >
                <ui-tag class="size-3.5" />
              </ui-button>
            </ui-tooltip-trigger>
            <ui-tooltip-content>重命名脚本</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <ui-button
                variant="ghost"
                size="icon"
                class="size-6"
                aria-label="移动到分组"
                @click="emit('move')"
              >
                <ui-folder-symlink class="size-3.5" />
              </ui-button>
            </ui-tooltip-trigger>
            <ui-tooltip-content>移动到分组</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <ui-button
                variant="ghost"
                size="icon"
                class="size-6"
                aria-label="导出脚本（zip）"
                :disabled="exporting"
                @click="emit('export')"
              >
                <ui-download class="size-3.5" />
              </ui-button>
            </ui-tooltip-trigger>
            <ui-tooltip-content>导出脚本（zip）</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <ui-button
                variant="ghost"
                size="icon"
                class="size-6 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                aria-label="删除脚本"
                :disabled="removing"
                @click="emit('remove')"
              >
                <ui-trash2 class="size-3.5" />
              </ui-button>
            </ui-tooltip-trigger>
            <ui-tooltip-content>删除脚本</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
      </div>
    </div>
  </div>
</template>
