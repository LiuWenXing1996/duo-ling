<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import type { SelectTriggerProps } from 'reka-ui'
import { SelectTrigger } from 'reka-ui'
import { ChevronDown as UiChevronDown } from '@lucide/vue'
import { cn } from '@/lib/utils'

const props = defineProps<SelectTriggerProps & { class?: HTMLAttributes['class'] }>()
</script>

<template>
  <SelectTrigger
    :class="
      cn(
        'border-input bg-transparent flex h-9 w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1',
        props.class
      )
    "
  >
    <slot />
    <ui-chevron-down class="size-4 shrink-0 text-muted-foreground opacity-50" />
  </SelectTrigger>
</template>
