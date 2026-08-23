<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import type { SelectValueProps } from 'reka-ui'
import { SelectValue } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<SelectValueProps & { class?: HTMLAttributes['class'] }>()
</script>

<template>
  <SelectValue :placeholder="props.placeholder" :class="cn('placeholder:text-muted-foreground', props.class)">
    <slot />
  </SelectValue>
</template>
