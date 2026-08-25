<script setup lang="ts">
// 工具图标：展示 meta.icon 的单个字符（emoji / 任意单字符）。
// icon 为空或未设置时，回退为工具名（fallback）的首字符；两者皆空则用 ✨。
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** meta.icon（主进程已归一化为单个字符或空串） */
    icon?: string
    /** 兜底：工具名（title），用于取首字符 */
    fallback?: string
  }>(),
  { icon: '', fallback: '' }
)

const char = computed(() => {
  const t = props.icon.trim()
  if (t) return [...t][0] ?? '✨'
  const fb = props.fallback.trim()
  return fb ? [...fb][0] ?? '✨' : '✨'
})
</script>

<template>
  <span class="tool-icon" aria-hidden="true">{{ char }}</span>
</template>

<style scoped>
.tool-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
</style>
