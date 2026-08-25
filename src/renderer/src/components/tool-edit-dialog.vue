<script setup lang="ts">
// 编辑工具弹窗：修改名称 / 图标（单字符）/ 描述；表单提交由父组件落地 meta.json 并同步展示。
import { ref, watch } from 'vue'
import type { ToolMeta } from '@/types/tool'
import { Button as UiButton } from '@/components/ui/button'
import { Input as UiInput } from '@/components/ui/input'
import {
  Dialog as UiDialog,
  DialogContent as UiDialogContent,
  DialogDescription as UiDialogDescription,
  DialogFooter as UiDialogFooter,
  DialogTitle as UiDialogTitle
} from '@/components/ui/dialog'
import EmojiPicker from './emoji-picker.vue'

const props = defineProps<{
  open: boolean
  tool: ToolMeta | null
}>()
const emit = defineEmits<{
  'update:open': [open: boolean]
  saved: [payload: { title: string; icon: string; description: string }]
}>()

const editTitle = ref('')
const editIcon = ref('')
const editDescription = ref('')
const emojiPanelOpen = ref(false)

// 每次打开弹窗时回填当前元信息到表单
watch(
  () => props.open,
  (open) => {
    if (open && props.tool) {
      editTitle.value = props.tool.title ?? ''
      editIcon.value = props.tool.icon ?? ''
      editDescription.value = props.tool.description ?? ''
      emojiPanelOpen.value = false
    }
  }
)

function cancel(): void {
  emit('update:open', false)
}

function save(): void {
  if (!props.tool) return
  emit('saved', {
    title: editTitle.value,
    icon: editIcon.value,
    description: editDescription.value
  })
}

function pickEmoji(emoji: string): void {
  editIcon.value = emoji
  emojiPanelOpen.value = false
}
</script>

<template>
  <ui-dialog :open="open" @update:open="(v) => emit('update:open', v)">
    <ui-dialog-content class="max-w-md">
      <ui-dialog-title class="text-base font-semibold">编辑工具</ui-dialog-title>
      <ui-dialog-description class="text-sm text-muted-foreground">
        修改工具的名称、图标与描述。
      </ui-dialog-description>
      <div class="edit-form">
        <label class="edit-form__label" for="edit-title">名称</label>
        <ui-input id="edit-title" v-model="editTitle" placeholder="工具名称" />
        <label class="edit-form__label" for="edit-icon">图标</label>
        <div class="edit-form__icon-row">
          <ui-input id="edit-icon" v-model="editIcon" placeholder="单个字符" class="flex-1" />
          <button
            class="edit-form__emoji-toggle"
            type="button"
            aria-label="选择 emoji"
            :aria-expanded="emojiPanelOpen"
            @click="emojiPanelOpen = !emojiPanelOpen"
          >
            😊
          </button>
        </div>
        <emoji-picker
          :open="emojiPanelOpen"
          :model-value="editIcon"
          @select="pickEmoji"
        />
        <p class="edit-form__hint">支持任意单个字符（emoji / 字母 / 汉字），留空则显示名称首字符。</p>
        <label class="edit-form__label" for="edit-desc">描述</label>
        <ui-input id="edit-desc" v-model="editDescription" placeholder="工具描述" />
      </div>
      <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
        <ui-button variant="ghost" size="sm" @click="cancel">
          取消
        </ui-button>
        <ui-button size="sm" @click="save">
          保存
        </ui-button>
      </ui-dialog-footer>
    </ui-dialog-content>
  </ui-dialog>
</template>

<style scoped lang="less">
.edit-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 16px 0 4px;

  &__label {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--foreground);
  }

  &__hint {
    margin: -2px 0 4px;
    font-size: 11.5px;
    color: var(--muted-foreground);
  }

  // 图标输入行：输入框 + emoji 切换按钮（并排）
  &__icon-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  &__emoji-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 36px;
    height: 36px;
    padding: 0;
    font-size: 16px;
    line-height: 1;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    transition: border-color 0.15s, background-color 0.15s;

    &:hover {
      border-color: var(--primary);
      background: var(--muted);
    }
  }
}
</style>
