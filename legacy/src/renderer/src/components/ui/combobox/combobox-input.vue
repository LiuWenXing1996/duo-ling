<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import type { ComboboxInputProps } from 'reka-ui'
import { ComboboxInput, useForwardProps } from 'reka-ui'
import { cn } from '@/lib/utils'

defineOptions({
  inheritAttrs: false
})

const props = withDefaults(
  defineProps<ComboboxInputProps & { class?: HTMLAttributes['class'] }>(),
  {
    class: ''
  }
)

const forwarded = useForwardProps(props)
</script>

<template>
  <ComboboxInput
    v-bind="{ ...forwarded, ...$attrs }"
    :class="
      cn(
        'min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground',
        props.class
      )
    "
  />
</template>
