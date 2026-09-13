<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import type { ComboboxContentEmits, ComboboxContentProps } from 'reka-ui'
import { ComboboxContent, ComboboxPortal, ComboboxViewport, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'

defineOptions({
  inheritAttrs: false
})

const props = withDefaults(
  defineProps<ComboboxContentProps & { class?: HTMLAttributes['class'] }>(),
  {
    position: 'popper',
    align: 'start',
    sideOffset: 8,
    class: ''
  }
)

const emits = defineEmits<ComboboxContentEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <ComboboxPortal>
    <ComboboxContent
      v-bind="{ ...forwarded, ...$attrs }"
      :class="
        cn(
          'bg-popover text-popover-foreground z-50 w-[var(--reka-popper-anchor-width)] min-w-[16rem] rounded-md border p-1 shadow-md outline-none',
          props.class
        )
      "
    >
      <ComboboxViewport class="max-h-80 overflow-y-auto p-1">
        <slot />
      </ComboboxViewport>
    </ComboboxContent>
  </ComboboxPortal>
</template>
