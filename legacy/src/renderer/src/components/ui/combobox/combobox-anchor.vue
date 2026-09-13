<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import type { ComboboxAnchorProps } from 'reka-ui'
import { ComboboxAnchor, useForwardProps } from 'reka-ui'
import { cn } from '@/lib/utils'

defineOptions({
  inheritAttrs: false
})

const props = withDefaults(
  defineProps<ComboboxAnchorProps & { class?: HTMLAttributes['class'] }>(),
  {
    class: ''
  }
)

const forwarded = useForwardProps(props)
</script>

<template>
  <ComboboxAnchor
    v-bind="{ ...forwarded, ...$attrs }"
    :class="cn('relative', props.class)"
  >
    <slot />
  </ComboboxAnchor>
</template>
