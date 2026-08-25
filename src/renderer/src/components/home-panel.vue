<script setup lang="ts">
// 主页面板：所有工具网格 + 新增工具。卡片点击打开对应工具标签，编辑/删除按钮由父组件处理弹窗。
import type { ToolMeta } from '@/types/tool'
import { Pencil as UiPencil, Plus as UiPlus, Trash2 as UiTrash } from '@lucide/vue'
import ToolIcon from './tool-icon.vue'

const props = defineProps<{
  tools: ToolMeta[]
  error: string
}>()
const emit = defineEmits<{
  create: []
  open: [tool: ToolMeta]
  edit: [tool: ToolMeta]
  delete: [tool: ToolMeta]
}>()
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
      <div
        v-for="tool in props.tools"
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
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 12px;
    align-content: start;
    padding: 16px;
  }

  &__empty {
    grid-column: 1 / -1;
    margin: 0;
    color: var(--muted-foreground);
    font-size: 13px;
    text-align: center;
    padding-top: 48px;
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
