<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { SwitchThumb } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <SwitchThumb
    :class="
      cn(
        'bg-background pointer-events-none block size-4 rounded-full shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
        props.class
      )
    "
  />
</template>
