<script setup lang="ts">
// 主页面板：工具按分组分区展示 + 新增工具。卡片点击打开对应工具标签，编辑/删除按钮由父组件处理弹窗。
import { computed, ref } from 'vue'
import type { ToolMeta } from '@/types/tool'
import { ChevronDown as UiChevronDown, Pencil as UiPencil, Plus as UiPlus, Trash2 as UiTrash } from '@lucide/vue'
import ToolIcon from './ToolIcon.vue'

const props = defineProps<{
  tools: ToolMeta[]
  /** 工具分组映射：toolId → 分组名（用户独立配置） */
  groupMap: Record<string, string>
  error: string
}>()
const emit = defineEmits<{
  create: []
  open: [tool: ToolMeta]
  edit: [tool: ToolMeta]
  delete: [tool: ToolMeta]
}>()

const UNGROUPED = '__ungrouped__'

interface ToolSection {
  key: string
  title: string
  tools: ToolMeta[]
}

// 按分组归集：有名分组按首次出现顺序排在前面，「未分组」固定归尾
const sections = computed<ToolSection[]>(() => {
  const buckets: Record<string, ToolMeta[]> = {}
  const order: string[] = []
  for (const tool of props.tools) {
    const group = (props.groupMap[tool.id] ?? '').trim()
    const key = group || UNGROUPED
    if (!buckets[key]) {
      buckets[key] = []
      if (key !== UNGROUPED) order.push(key)
    }
    buckets[key].push(tool)
  }
  const result: ToolSection[] = order.map((key) => ({ key, title: key, tools: buckets[key] }))
  if (buckets[UNGROUPED]) {
    result.push({ key: UNGROUPED, title: '未分组', tools: buckets[UNGROUPED] })
  }
  return result
})

// 各分区折叠状态（key 为分组名或 UNGROUPED）；默认全部展开
const collapsed = ref<Record<string, boolean>>({})

function toggleCollapse(key: string): void {
  collapsed.value = { ...collapsed.value, [key]: !collapsed.value[key] }
}
</script>

<template>
  <div class="home-panel">
    <header class="home-panel__header">
      <h1 class="text-base font-semibold">主页</h1>
      <button class="home-panel__new no-drag" type="button" @click="emit('create')">
        <ui-plus class="size-4" />
        <span>新增工具</span>
      </button>
    </header>
    <p v-if="props.error" class="home-panel__error">{{ props.error }}</p>
    <div class="home-panel__body">
      <section
        v-for="sec in sections"
        :key="sec.key"
        class="tool-section"
      >
        <button
          class="tool-section__header no-drag"
          type="button"
          :aria-expanded="!collapsed[sec.key]"
          @click="toggleCollapse(sec.key)"
        >
          <ui-chevron-down class="tool-section__chevron" :class="{ 'tool-section__chevron--collapsed': collapsed[sec.key] }" />
          <span class="tool-section__title">{{ sec.title }}</span>
          <span class="tool-section__count">{{ sec.tools.length }}</span>
        </button>
        <div v-show="!collapsed[sec.key]" class="tool-section__grid">
          <div
            v-for="tool in sec.tools"
            :key="tool.id"
            class="tool-card"
            role="button"
            tabindex="0"
            @click="emit('open', tool)"
            @keydown.enter="emit('open', tool)"
          >
            <div class="tool-card__actions no-drag">
              <button
                class="tool-card__action tool-card__action--edit"
                type="button"
                aria-label="编辑工具"
                title="编辑工具"
                @click.stop="emit('edit', tool)"
              >
                <ui-pencil class="size-3.5" />
              </button>
              <button
                class="tool-card__action tool-card__action--delete"
                type="button"
                aria-label="删除工具"
                title="删除工具"
                @click.stop="emit('delete', tool)"
              >
                <ui-trash class="size-3.5" />
              </button>
            </div>
            <span class="tool-card__icon">
              <tool-icon :icon="tool.icon" :fallback="tool.title" class="text-base" />
            </span>
            <span class="tool-card__title">{{ tool.title }}</span>
            <span class="tool-card__desc">{{ tool.description }}</span>
          </div>
        </div>
      </section>
      <p v-if="!props.tools.length" class="home-panel__empty">还没有工具，点击右上角「新增工具」创建</p>
    </div>
  </div>
</template>

<style scoped lang="less">
.home-panel {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;

  &__header {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 48px;
    padding: 0 16px;
    border-bottom: 1px solid var(--border);
  }

  &__new {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 12px;
    font-size: 12.5px;
    color: var(--primary-foreground);
    background: var(--primary);
    border-radius: 6px;
    transition: opacity 0.15s;

    &:hover {
      opacity: 0.88;
    }
  }

  &__error {
    flex: none;
    margin: 0;
    padding: 8px 16px 0;
    color: var(--destructive);
    font-size: 12.5px;
  }

  &__body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
  }

  &__empty {
    margin: 0;
    color: var(--muted-foreground);
    font-size: 13px;
    text-align: center;
    padding-top: 48px;
  }
}

// 分组分区：标题行（可折叠）+ 工具网格
.tool-section {
  &__header {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 2px;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted-foreground);
    text-align: left;
    background: none;
    border: 0;
    border-radius: 6px;
    cursor: pointer;
    transition: color 0.15s;

    &:hover {
      color: var(--foreground);
    }
  }

  &__chevron {
    flex: none;
    width: 14px;
    height: 14px;
    transition: transform 0.15s;

    &--collapsed {
      transform: rotate(-90deg);
    }
  }

  &__title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__count {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    font-size: 11px;
    font-weight: 500;
    color: var(--muted-foreground);
    background: var(--muted);
    border-radius: 9px;
  }

  &__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 12px;
    align-content: start;
  }
}

// 工具卡片：点击打开对应工具标签
.tool-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px;
  text-align: left;
  cursor: pointer;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  transition: border-color 0.15s, background-color 0.15s;

  &:hover {
    border-color: var(--primary);
    background: var(--muted);

    .tool-card__actions {
      opacity: 1;
    }
  }

  &:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }

  // 右上角操作按钮（编辑 / 删除）：默认隐藏，悬停卡片时显示
  &__actions {
    position: absolute;
    top: 8px;
    right: 8px;
    display: inline-flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.15s;
  }

  &__action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    color: var(--muted-foreground);
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 6px;
    transition: color 0.15s, border-color 0.15s;

    &--edit:hover {
      color: var(--primary);
      border-color: var(--primary);
    }

    &--delete:hover {
      color: var(--destructive);
      border-color: var(--destructive);
    }
  }

  &__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin-bottom: 4px;
    color: var(--primary);
    background: var(--muted);
    border-radius: 6px;
  }

  &__title {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--foreground);
  }

  &__desc {
    font-size: 12px;
    color: var(--muted-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
</style>
