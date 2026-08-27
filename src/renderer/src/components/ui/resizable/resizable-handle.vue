<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import type { SplitterResizeHandleProps } from 'reka-ui'
import { SplitterResizeHandle, useForwardProps } from 'reka-ui'
import { cn } from '@/lib/utils'

defineOptions({
  inheritAttrs: false
})

const props = withDefaults(
  defineProps<SplitterResizeHandleProps & { class?: HTMLAttributes['class'] }>(),
  {
    class: ''
  }
)

const forwarded = useForwardProps(props)
</script>

<template>
  <SplitterResizeHandle
    v-bind="{ ...forwarded, ...$attrs }"
    :class="
      cn(
        'relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 after:transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 data-[state=drag]:bg-primary data-[state=hover]:bg-primary',
        'data-[orientation=vertical]:h-px data-[orientation=vertical]:w-full data-[orientation=vertical]:after:left-0 data-[orientation=vertical]:after:right-0 data-[orientation=vertical]:after:h-1 data-[orientation=vertical]:after:w-full data-[orientation=vertical]:after:-translate-x-0 data-[orientation=vertical]:after:-translate-y-1/2',
        props.class
      )
    "
  >
    <slot />
  </SplitterResizeHandle>
</template>
