<script setup lang="ts">
// 「其他页面」区块：其他打开的页面各自的脚本与会话，点「去这里」切过去。
//
// 布局与「当前页面」同款（大卡套小卡）：外卡是「其他页面」，每个页面一行各是里面的一张子卡
// （子卡低一档圆角，与外卡的层次看得出来）。
//
// 只列普通网页（http/https）：内部页 / 扩展页里既跑不了脚本也挂不了浮层，列出来只是噪音 ——
// 过滤在 SW 侧完成（见 shared/extension-ipc 的 PageOverviewTab），这里不再判一次。
//
// 切换**只走「去这里」按钮**（不顺手把那一页的浮层调出来）：用户点它多半是去那个页面干活，未必
// 是要跟它对上话（要对话，切过去再点「打开会话」，或者直接在那儿用页面右键菜单）。内容区刻意
// 不可点 —— 整卡都是点击目标容易误触切走。
import { Button as UiButton } from '@/components/ui/button'
import { webHostname } from '@/lib/float-panel-host'
import type { PageOverviewTab } from '@/shared/extension-ipc'

defineProps<{
  /** 其他标签页的概览（不含当前页；顺序 = SW 给出的标签页顺序） */
  tabs: readonly PageOverviewTab[]
}>()

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
    <div class="flex items-center gap-2 border-b border-border px-3 py-2">
      <span class="text-sm font-medium">其他页面</span>
      <span v-if="tabs.length" class="text-xs text-muted-foreground tabular-nums">
        {{ tabs.length }} 个
      </span>
    </div>

    <p
      v-if="!tabs.length"
      class="px-3 py-2 text-xs text-muted-foreground"
      data-testid="popup-other-pages-empty"
    >
      没有其他打开的页面
    </p>

    <div v-else class="flex max-h-56 flex-col gap-2 overflow-y-auto p-2">
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
        <UiButton
          variant="outline"
          size="sm"
          class="h-7 shrink-0 px-2 text-xs"
          data-testid="popup-other-page-go"
          @click="switchTo(tab.tabId)"
        >
          去这里
        </UiButton>
      </div>
    </div>
  </div>
</template>
