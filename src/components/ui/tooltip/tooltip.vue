<script setup lang="ts">
import type { TooltipRootEmits, TooltipRootProps } from "reka-ui"
import { TooltipRoot, useForwardPropsEmits } from "reka-ui"

const props = withDefaults(defineProps<TooltipRootProps>(), {
  // 上游 bug（unovue/reka-ui#2598）：鼠标快速滑进 tooltip 内容或 trigger 与 tooltip
  // 的空隙时不会关闭。图标按钮的纯文字提示不需要「悬停内容保持打开」，默认禁用；
  // 指针离开 trigger 即收。个别需要 hover 进内容的场景可按需传 false 覆盖。
  disableHoverableContent: true
})
const emits = defineEmits<TooltipRootEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <TooltipRoot
    v-slot="slotProps"
    data-slot="tooltip"
    v-bind="forwarded"
  >
    <slot v-bind="slotProps" />
  </TooltipRoot>
</template>
