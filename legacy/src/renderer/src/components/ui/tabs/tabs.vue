<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import type { TabsRootEmits, TabsRootProps } from 'reka-ui'
import { TabsRoot, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'

defineOptions({
  inheritAttrs: false
})

const props = withDefaults(
  defineProps<TabsRootProps & { class?: HTMLAttributes['class'] }>(),
  {
    class: ''
  }
)

const emits = defineEmits<TabsRootEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <TabsRoot v-bind="{ ...forwarded, ...$attrs }" :class="cn(props.class)">
    <slot />
  </TabsRoot>
</template>
