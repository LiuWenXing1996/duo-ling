<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import type { TabsListProps } from 'reka-ui'
import { TabsList, useForwardProps } from 'reka-ui'
import { cn } from '@/lib/utils'

defineOptions({
  inheritAttrs: false
})

const props = withDefaults(
  defineProps<TabsListProps & { class?: HTMLAttributes['class'] }>(),
  {
    class: ''
  }
)

const forwarded = useForwardProps(props)
</script>

<template>
  <TabsList
    v-bind="{ ...forwarded, ...$attrs }"
    :class="
      cn(
        'inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground',
        props.class
      )
    "
  >
    <slot />
  </TabsList>
</template>
