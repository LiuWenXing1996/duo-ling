<script setup lang="ts">
// 工具图标，支持两种来源：
// 1. meta.icon 为单个字符（emoji / 任意单字符）→ 直接渲染字符
// 2. meta.icon 为 `lucide:<名称>`（kebab-case，见 lib/lucide-icons 允许列表）→ 按需动态加载 lucide 图标
// 两者皆空或解析失败时，回退为工具名（fallback）首字符；再兜底 ✨。
import { computed, defineAsyncComponent, type Component } from 'vue'
import { lucideIconLoader } from '@/lib/lucide-icons'

const props = withDefaults(
  defineProps<{
    /** meta.icon（主进程已归一化为单个字符或 lucide:<名称> 或空串） */
    icon?: string
    /** 兜底：工具名（title），用于取首字符 */
    fallback?: string
  }>(),
  { icon: '', fallback: '' }
)

/** lucide 图标：icon 为 `lucide:<名称>` 且在允许列表内时返回异步组件，否则 null（走字符回退） */
const lucideComponent = computed<Component | null>(() => {
  const t = props.icon.trim()
  if (!t.startsWith('lucide:')) return null
  const name = t.slice('lucide:'.length)
  const loader = lucideIconLoader(name)
  return loader ? defineAsyncComponent(loader as () => Promise<Component>) : null
})

const char = computed(() => {
  const t = props.icon.trim()
  // lucide: 前缀走图标组件分支；仅在无法加载（不在允许列表）时才落入本字符回退
  if (t && !t.startsWith('lucide:')) return [...t][0] ?? '✨'
  const fb = props.fallback.trim()
  return fb ? [...fb][0] ?? '✨' : '✨'
})
</script>

<template>
  <component :is="lucideComponent" v-if="lucideComponent" class="tool-icon" aria-hidden="true" />
  <span v-else class="tool-icon" aria-hidden="true">{{ char }}</span>
</template>

<style scoped>
.tool-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
</style>
