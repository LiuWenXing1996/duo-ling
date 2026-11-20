<script setup lang="ts">
import { ref } from 'vue'
import {
  ChevronDown as UiChevronDown,
  ChevronRight as UiChevronRight,
  ExternalLink as UiExternalLink,
} from '@lucide/vue'
import { Button as UiButton } from '@duoling/ui/components/ui/button'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger,
} from '@duoling/ui/components/ui/tooltip'
import { webHostname } from '@duoling/shared'
import type { PageOverviewTab } from '@duoling/shared'

defineProps<{
  /** 其他标签页的概览（不含当前页；顺序 = SW 给出的标签页顺序） */
  tabs: readonly PageOverviewTab[]
}>()

const open = ref(false)

/** 切到某个标签页并关窗；标签页刚好没了就静默退场（这是 popup 与页面失联的异常态，报错只是噪音） */
async function switchTo(tabId: number): Promise<void> {
  try {
    await chrome.tabs.update(tabId, { active: true })
  } catch {
    return
  }
  window.close()
}

/**
 * 行的第二行：脚本数 + 会话状态。
 *
 * 两样都没有时退化为**页面标题** —— 这一页此刻没活动，但列表是按「所有打开的页面」列的，
 * 标题（而不是空着）才是能帮用户认出「要不要切过去」的那条信息。
 */
function metaOf(tab: PageOverviewTab): string {
  const parts: string[] = []
  if (tab.scripts.length) parts.push(`${tab.scripts.length} 个脚本`)
  if (tab.conversationId) {
    const title = tab.conversationTitle ? `「${tab.conversationTitle}」` : ''
    parts.push(tab.generating ? `正在生成${title}` : title || '有会话')
  }
  return parts.length ? parts.join(' · ') : tab.title || '无活动'
}
</script>

<template>
  <div class="rounded-lg border border-border" data-testid="popup-other-pages">
    <button
      v-if="tabs.length"
      type="button"
      class="flex w-full items-center gap-1.5 px-3 py-2 text-left"
      :aria-expanded="open"
      aria-label="展开或收起其他页面"
      data-testid="popup-other-pages-toggle"
      @click="open = !open"
    >
      <ui-chevron-down v-if="open" class="size-3 shrink-0 text-muted-foreground" />
      <ui-chevron-right v-else class="size-3 shrink-0 text-muted-foreground" />
      <span class="text-sm font-medium">其他页面</span>
      <span class="text-xs text-muted-foreground tabular-nums">{{ tabs.length }} 个</span>
    </button>
    <div v-else class="flex items-center gap-2 px-3 py-2">
      <span class="text-sm font-medium">其他页面</span>
    </div>

    <p
      v-if="!tabs.length"
      class="px-3 pb-2 text-xs text-muted-foreground"
      data-testid="popup-other-pages-empty"
    >
      没有其他打开的页面
    </p>

    <div
      v-else-if="open"
      class="flex max-h-56 flex-col gap-2 overflow-y-auto border-t border-border p-2"
    >
      <!-- 切换只归「去这里」按钮：内容区不可点（整卡都是点击目标容易误触切走），也不给 hover 反馈 -->
      <div
        v-for="tab in tabs"
        :key="tab.tabId"
        class="flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-1.5"
        :title="tab.title || undefined"
      >
        <div class="min-w-0 flex-1" data-testid="popup-other-page-row">
          <div class="flex min-w-0 items-center gap-1.5">
            <span v-if="tab.generating" class="size-1.5 shrink-0 rounded-full bg-primary" />
            <span class="min-w-0 truncate text-xs font-medium">{{ webHostname(tab.url) }}</span>
          </div>
          <div class="min-w-0 truncate text-[11px] text-muted-foreground">{{ metaOf(tab) }}</div>
        </div>
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <ui-button
                variant="ghost"
                size="icon"
                class="size-7 shrink-0"
                aria-label="去这里"
                data-testid="popup-other-page-go"
                @click="switchTo(tab.tabId)"
              >
                <ui-external-link class="size-3.5" />
              </ui-button>
            </ui-tooltip-trigger>
            <ui-tooltip-content side="top">去这里</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
      </div>
    </div>
  </div>
</template>
