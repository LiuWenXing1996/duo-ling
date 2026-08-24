<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import type { SplitterGroupProps } from 'reka-ui'
import { SplitterGroup, useForwardProps } from 'reka-ui'
import { cn } from '@/lib/utils'

defineOptions({
  inheritAttrs: false
})

const props = withDefaults(
  defineProps<SplitterGroupProps & { class?: HTMLAttributes['class'] }>(),
  {
    class: ''
  }
)

const forwarded = useForwardProps(props)
</script>

<template>
  <SplitterGroup
    v-bind="{ ...forwarded, ...$attrs }"
    :class="cn('flex h-full w-full', props.class)"
  >
    <slot />
  </SplitterGroup>
</template>
