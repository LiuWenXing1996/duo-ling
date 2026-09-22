<script setup lang="ts">
// 会话列表项上的「生成中」标 + 就地停止。
//
// 为什么需要它：会话按标签页归属，但任务跑在 offscreen、与页面无关 —— 标签页可能已经被关掉
// （这时标签页关闭会主动中止任务，见 background），也可能用户正在工作台里翻历史。
// 这两种情况下他都没有「回到那条会话的浮层去按停止」的机会，任务就会在后台静默消耗 token。
// 所以状态与停止入口都摆到会话列表上。
import { Square as UiSquare } from '@lucide/vue'
import { Badge as UiBadge } from '@/components/ui/badge'
import { Button as UiButton } from '@/components/ui/button'

defineEmits<{ stop: [] }>()
</script>

<template>
  <div class="flex shrink-0 items-center gap-0.5">
    <UiBadge
      variant="secondary"
      class="h-5 gap-1 px-1.5 text-[10px] font-normal"
      data-testid="session-running"
    >
      <span class="size-1.5 rounded-full bg-primary" />
      生成中
    </UiBadge>
    <!-- 用原生 title 而不是 Tooltip：列表行本身是可点区域，套 tooltip 只会让这一行更重 -->
    <UiButton
      variant="ghost"
      size="icon"
      class="size-6 shrink-0 text-muted-foreground hover:text-destructive"
      aria-label="停止生成"
      title="停止生成"
      data-testid="session-stop"
      @click.stop="$emit('stop')"
    >
      <UiSquare class="size-3" />
    </UiButton>
  </div>
</template>
