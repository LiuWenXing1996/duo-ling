<script setup lang="ts">
// 工具栏 popup 的「本页脚本」分区：一行摘要（脚本数 + 错误数）+ 默认收起的列表。
//
// 数据来源与对话界面灵动岛（PageScriptsMonitor）同一条 —— SW 的运行登记表经 duoling:panel
// 端口按 tabId 回快照，见 composables/use-page-monitor。两处差异只在归属与形态：
//   · 归属传 resolveActiveTabId：popup 是用户点开那一刻弹出来的，此刻的激活页就是答案。
//     （浮层则认 pinned tab —— 用户切走后浮层还挂在原 tab 上，认 active 会显示别人的脚本，
//     判据见 lib/owning-tab.ts）
//   · 形态是 popup 里的常驻卡片，不是浮在页面上的灵动岛：不绝对定位、不做形变动画、
//     配色跟随 popup 的卡片（灵动岛用反色面 + motion 弹簧，那是浮层的表达）。
//
// 默认收起：popup 宽 340px，展开后的列表限高内滚，免得面板被脚本数撑高。
// 没有脚本在跑时不给可点性、也不渲染列表，摘要行直接就是空态。
import { ref } from 'vue'
import { ChevronDown as UiChevronDown } from '@lucide/vue'
import { Badge as UiBadge } from '@/components/ui/badge'
import { usePageMonitor } from '@/composables/use-page-monitor'
import { resolveActiveTabId } from '@/lib/owning-tab'

const { runs, errors, displayName, errorsOf, openErrors } = usePageMonitor({
  resolveTabId: resolveActiveTabId,
})

const expanded = ref(false)

/**
 * 点脚本行 → 深链到工作台该脚本的错误日志，随后关掉面板。
 * 关闭延后一帧：上行是异步投递，同一 tick 里关掉文档会让这条 postMessage 悬空。
 * （新标签页激活后 popup 多半也会自己消失，但焦点转移到已有标签页时不保证，故显式关。）
 */
function openScript(uuid: string): void {
  openErrors(uuid)
  setTimeout(() => window.close(), 0)
}
</script>

<template>
  <div class="rounded-lg border border-border" data-testid="popup-page-scripts">
    <button
      class="flex w-full items-center gap-2 p-3 text-left"
      :disabled="!runs.length"
      data-testid="popup-page-scripts-toggle"
      @click="expanded = !expanded"
    >
      <span class="text-sm font-medium">本页脚本</span>
      <span v-if="runs.length" class="text-xs text-muted-foreground tabular-nums">
        {{ runs.length }} 个在运行
      </span>
      <span v-else class="text-xs text-muted-foreground">本页没有运行中的脚本</span>
      <span class="ml-auto flex shrink-0 items-center gap-1.5">
        <UiBadge
          v-if="errors.length"
          variant="destructive"
          data-testid="popup-page-scripts-error-count"
        >
          {{ errors.length }}
        </UiBadge>
        <UiChevronDown
          v-if="runs.length"
          class="size-3.5 text-muted-foreground transition-transform duration-200"
          :class="expanded ? 'rotate-180' : ''"
        />
      </span>
    </button>

    <div
      v-if="runs.length && expanded"
      class="max-h-40 overflow-y-auto border-t border-border px-3 py-1"
    >
      <button
        v-for="run in runs"
        :key="run.uuid"
        class="flex w-full items-center gap-2 border-b border-border py-1.5 text-left last:border-b-0"
        :title="run.uuid"
        data-testid="popup-page-scripts-row"
        @click="openScript(run.uuid)"
      >
        <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ displayName(run.uuid) }}</span>
        <span
          v-if="errorsOf(run.uuid).length"
          class="shrink-0 text-[10px] font-semibold text-destructive"
          :title="`最新：${errorsOf(run.uuid)[0]?.message ?? ''}`"
        >
          ⚠ {{ errorsOf(run.uuid).length }}
        </span>
        <span v-else class="shrink-0 text-[10px] text-muted-foreground">运行中</span>
      </button>
    </div>
  </div>
</template>
