<script setup lang="ts">
import { Square as UiSquare } from '@lucide/vue'
import { Badge as UiBadge } from '@duoling/ui/components/ui/badge'
import { Button as UiButton } from '@duoling/ui/components/ui/button'

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
