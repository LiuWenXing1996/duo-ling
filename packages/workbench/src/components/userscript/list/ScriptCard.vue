<script setup lang="ts">
// 脚本卡片（列表网格的单个单元）：图标 + 名称 + 状态标 → 匹配规则 → 元信息 → 底部开关 + 操作。
// 本组件只负责展示与发起动作，所有写操作回传给父级（列表壳）执行 —— 状态与命令面不在这里。
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
  /** 卡片对应的脚本 */
  s: ScriptSummary
  /** 启停请求在途（本卡）：开关置灰防连点 */
  toggling: boolean
  /** 删除请求在途（本卡）：删除按钮置灰 */
  removing: boolean
  /** 刚由「添加脚本」建成（includes 已由父级算好） */
  justCreated: boolean
  /** 刚导入（includes 已由父级算好；是否未启用由本卡结合 s.enabled 判断） */
  justImportedBadge: boolean
  /** 保存链瞬态（转圈标） */
  saving: boolean
  /** 导出请求在途（全局）：导出按钮置灰防重复导出 */
  exporting: boolean
  /** ID 复制成功反馈（本卡，1.5s 短暂态） */
  copied: boolean
}>()

const emit = defineEmits<{
  /** 启停开关翻转（写操作在父级） */
  toggle: [next: boolean]
  /** 进编辑器 */
  edit: []
  /** 开重命名弹窗 */
  rename: []
  /** 开移动到分组弹窗 */
  move: []
  /** 开导出确认弹窗（zip） */
  export: []
  /** 开删除确认弹窗 */
  remove: []
  /** 复制完整脚本 ID */
  copyId: []
}>()

/** 列表里的时间戳（savedAt）是毫秒，而 formatTimestamp 收的是 Unix 秒，需换算 */
function timeLabel(ts: number): string {
  return ts ? formatTimestamp(Math.floor(ts / 1000)) : ''
}
</script>

<template>
  <!-- 脚本卡片：图标 + 名称 + 状态标 → 匹配规则 → 元信息 → 底部开关 + 操作 -->
  <div class="flex flex-col rounded-md border bg-card p-3">
    <!-- 顶部：图标 + 名称（独占一行）+ 状态标（统一另起一行） -->
    <div class="flex items-start gap-2">
      <span
        class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
      >
        <ui-braces class="size-3.5" />
      </span>
      <div class="min-w-0 flex-1">
        <!-- 名称独占一行（超长省略，悬停 Tooltip 看全名）；状态标与脚本 ID 统一另起一行 ——
             避免窄卡片里 shrink-0 的状态标 / ID 牌把可收缩的名称挤到只剩一个字 -->
        <ui-tooltip-provider>
          <!-- TooltipProvider：名称与状态标悬停时刻用 shadcn Tooltip（原生 title 有 ~1s 浏览器
               延时）；Provider 默认 0ms 即显——TooltipRoot 必须有 Provider 上下文。
               Provider 只渲染 slot、不产元素，故名称与状态标行仍是本容器的直接块级子项 -->
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
            <!-- 刚由「添加脚本」建成：新建不跳编辑器，靠这个标告诉人哪个是刚建的 -->
            <span
              v-else-if="justCreated"
              class="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
            >
              刚新建
            </span>
            <!-- 保存状态标：保存链瞬态（转圈），落库广播到达即消失 -->
            <span
              v-if="saving"
              class="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
            >
              <ui-loader-circle class="size-3 animate-spin" />
              保存中
            </span>
            <!-- 脚本 ID 短形态（常显，标题下方）：与 AI 对话里说的脚本对上号；点击复制完整 uuid -->
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

    <!-- 匹配规则（占满一行，截断）：标签与元信息三行同款，只有模式串用等宽 -->
    <p class="mt-2 truncate text-xs text-muted-foreground">
      匹配规则：<span class="font-mono">{{ s.matches.join(', ') || '无' }}</span>
    </p>
    <!-- 元信息：源码最后保存时刻。运行观测按页收在「活动历史」里，列表不重复一行计数 -->
    <div class="mb-3 mt-1 space-y-0.5 text-xs text-muted-foreground tabular-nums">
      <p>更新时间：{{ timeLabel(s.savedAt) || '无' }}</p>
    </div>

    <!-- 底部：启用开关 + 操作（编辑 / 移动 / 导出 / 删除）；
         mt-auto 把底行钉在卡片底（网格同排卡片等高），
         内容长短不齐时分隔线也对齐 -->
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
        <!-- 移动到分组：点开弹窗选分组（不用下拉菜单 —— 菜单触发器套不了 Tooltip，见 AGENTS.md） -->
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
        <!-- 导出（zip）：确认弹窗统一带隐私提示 -->
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
