<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import type { SplitterPanelProps } from 'reka-ui'
import { SplitterPanel, useForwardProps } from 'reka-ui'
import { cn } from '@/lib/utils'

defineOptions({
  inheritAttrs: false
})

const props = withDefaults(
  defineProps<SplitterPanelProps & { class?: HTMLAttributes['class'] }>(),
  {
    class: ''
  }
)

const forwarded = useForwardProps(props)
</script>

<template>
  <SplitterPanel
    v-bind="{ ...forwarded, ...$attrs }"
    :class="cn('flex flex-col', props.class)"
  >
    <slot />
  </SplitterPanel>
</template>
