<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import type { ComboboxItemEmits, ComboboxItemProps } from 'reka-ui'
import { ComboboxItem, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'

defineOptions({
  inheritAttrs: false
})

const props = withDefaults(
  defineProps<ComboboxItemProps & { class?: HTMLAttributes['class'] }>(),
  {
    class: ''
  }
)

const emits = defineEmits<ComboboxItemEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <ComboboxItem
    v-bind="{ ...forwarded, ...$attrs }"
    :class="
      cn(
        'relative flex cursor-pointer select-none flex-col gap-0.5 rounded-sm px-2.5 py-1.5 text-sm outline-none transition-colors data-[highlighted]:bg-muted data-[highlighted]:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        props.class
      )
    "
  >
    <slot />
  </ComboboxItem>
</template>
