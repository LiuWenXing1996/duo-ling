<script setup lang="ts">
// lucide 图标选择面板：搜索名称 + 网格预览（按需异步加载允许列表内的图标）。
// 选中后 emit `lucide:<名称>`，由编辑弹窗写入 meta.icon。
import { computed, defineAsyncComponent, ref, type Component } from 'vue'
import { Search as UiSearch } from '@lucide/vue'
import { lucideIconLoader, lucideIconNames } from '@/lib/lucide-icons'

const props = withDefaults(
  defineProps<{
    /** 面板是否展开 */
    open: boolean
    /** 当前选中的图标值（如 `lucide:sparkle`，用于高亮） */
    modelValue: string
  }>(),
  { modelValue: '' }
)
const emit = defineEmits<{ select: [value: string] }>()

// 允许列表名称（从 glob key 派生），模块加载时取一次即可
const names = lucideIconNames()
const query = ref('')

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return q ? names.filter((n) => n.includes(q)) : names
})

// 默认只渲染前 120 个，避免面板打开时一次加载过多图标 chunk；搜索词可命中全量
const visible = computed(() => filtered.value.slice(0, 120))

// 异步组件按名称缓存，避免重复创建
const componentCache = new Map<string, Component>()
function iconComponent(name: string): Component {
  let comp = componentCache.get(name)
  if (!comp) {
    const loader = lucideIconLoader(name)
    comp = loader ? defineAsyncComponent(loader as () => Promise<Component>) : ({} as Component)
    componentCache.set(name, comp)
  }
  return comp
}
</script>

<template>
  <div v-if="open" class="lucide-picker" role="listbox" aria-label="选择 lucide 图标">
    <div class="lucide-picker__search">
      <ui-search class="lucide-picker__search-icon" :size="14" />
      <input
        v-model="query"
        class="lucide-picker__search-input"
        type="text"
        placeholder="搜索图标名称"
        aria-label="搜索 lucide 图标"
      />
    </div>
    <div v-if="visible.length" class="lucide-picker__grid">
      <button
        v-for="name in visible"
        :key="name"
        class="lucide-picker__item"
        type="button"
        role="option"
        :aria-selected="props.modelValue === `lucide:${name}`"
        :title="name"
        @click="emit('select', `lucide:${name}`)"
      >
        <component :is="iconComponent(name)" />
      </button>
    </div>
    <p v-else class="lucide-picker__empty">无匹配图标</p>
    <p v-if="filtered.length > visible.length" class="lucide-picker__more">
      共 {{ filtered.length }} 个，输入名称搜索更多
    </p>
  </div>
</template>

<style scoped lang="less">
.lucide-picker {
  padding: 8px;
  background: var(--popover);
  border: 1px solid var(--border);
  border-radius: 8px;

  &__search {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    margin-bottom: 6px;
    border: 1px solid var(--border);
    border-radius: 6px;

    &:focus-within {
      border-color: var(--primary);
    }
  }

  &__search-icon {
    flex: none;
    color: var(--muted-foreground);
  }

  &__search-input {
    min-width: 0;
    flex: 1;
    height: 28px;
    font-size: 12.5px;
    color: var(--foreground);
    background: transparent;
    border: none;
    outline: none;

    &::placeholder {
      color: var(--muted-foreground);
    }
  }

  &__grid {
    display: grid;
    grid-template-columns: repeat(10, 1fr);
    gap: 4px;
    max-height: 168px;
    overflow-y: auto;
  }

  &__item {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    aspect-ratio: 1;
    padding: 0;
    color: var(--foreground);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    transition: background-color 0.15s, border-color 0.15s;

    :deep(svg) {
      width: 18px;
      height: 18px;
    }

    &:hover {
      background: var(--muted);
    }

    &[aria-selected='true'] {
      border-color: var(--primary);
      background: var(--muted);
    }
  }

  &__empty {
    padding: 12px 0;
    font-size: 12px;
    text-align: center;
    color: var(--muted-foreground);
  }

  &__more {
    margin-top: 6px;
    font-size: 11.5px;
    text-align: center;
    color: var(--muted-foreground);
  }
}
</style>
