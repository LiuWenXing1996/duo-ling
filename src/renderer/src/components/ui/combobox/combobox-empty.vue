<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import type { ComboboxEmptyProps } from 'reka-ui'
import { ComboboxEmpty, useForwardProps } from 'reka-ui'
import { cn } from '@/lib/utils'

defineOptions({
  inheritAttrs: false
})

const props = withDefaults(
  defineProps<ComboboxEmptyProps & { class?: HTMLAttributes['class'] }>(),
  {
    class: ''
  }
)

const forwarded = useForwardProps(props)
</script>

<template>
  <ComboboxEmpty
    v-bind="{ ...forwarded, ...$attrs }"
    :class="cn('py-6 text-center text-sm text-muted-foreground', props.class)"
  >
    <slot />
  </ComboboxEmpty>
</template>
