<script setup lang="ts">
import type { TooltipRootEmits, TooltipRootProps } from 'reka-ui'
import { TooltipProvider, TooltipRoot, useForwardPropsEmits } from 'reka-ui'

const props = withDefaults(defineProps<TooltipRootProps>(), {
  delayDuration: 200
})

const emits = defineEmits<TooltipRootEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <TooltipProvider>
    <TooltipRoot v-bind="forwarded">
      <slot />
    </TooltipRoot>
  </TooltipProvider>
</template>
