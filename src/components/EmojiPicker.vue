<script setup lang="ts">
// 常用单码点 emoji，供图标选择面板使用（主进程仅接受单个字符/码点）
const EMOJI_OPTIONS = [
  '😀', '😁', '😂', '🤣', '😊', '😍', '😎', '🤔', '😴', '🤖',
  '👋', '👌', '👍', '💪', '🙏', '👏', '🔥', '⭐', '🌟', '✨',
  '🌈', '⚡', '☀', '🌙', '☕', '🍎', '🍕', '🎯', '🏆', '🎨',
  '🎵', '📅', '⏰', '💡', '🚀', '🌐', '📌', '📁', '📄', '📚',
  '📝', '📊', '📈', '🧮', '🔧', '🧰', '🔍', '🔐', '🔔', '🧭',
  '🧩', '🧪', '📦', '📎', '💾'
]

const props = withDefaults(
  defineProps<{
    /** 面板是否展开 */
    open: boolean
    /** 当前选中的图标（用于高亮） */
    modelValue: string
  }>(),
  { modelValue: '' }
)
const emit = defineEmits<{ select: [emoji: string] }>()
</script>

<template>
  <div
    v-if="open"
    class="emoji-picker"
    role="listbox"
    aria-label="选择图标 emoji"
  >
    <button
      v-for="emoji in EMOJI_OPTIONS"
      :key="emoji"
      class="emoji-picker__item"
      type="button"
      role="option"
      :aria-selected="emoji === props.modelValue"
      :title="emoji"
      @click="emit('select', emoji)"
    >
      {{ emoji }}
    </button>
  </div>
</template>

<style scoped lang="less">
.emoji-picker {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 4px;
  padding: 8px;
  max-height: 168px;
  overflow-y: auto;
  background: var(--popover);
  border: 1px solid var(--border);
  border-radius: 8px;

  &__item {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    aspect-ratio: 1;
    padding: 0;
    font-size: 18px;
    line-height: 1;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    transition: background-color 0.15s, border-color 0.15s;

    &:hover {
      background: var(--muted);
    }

    &[aria-selected='true'] {
      border-color: var(--primary);
      background: var(--muted);
    }
  }
}
</style>
