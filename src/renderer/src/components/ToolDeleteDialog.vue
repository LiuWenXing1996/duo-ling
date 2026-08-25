<script setup lang="ts">
// 删除工具确认弹窗：使用 UI 弹窗而非原生 confirm，避免阻塞主进程渲染。
import type { ToolMeta } from '@/types/tool'
import { Button as UiButton } from '@/components/ui/button'
import {
  Dialog as UiDialog,
  DialogContent as UiDialogContent,
  DialogDescription as UiDialogDescription,
  DialogFooter as UiDialogFooter,
  DialogTitle as UiDialogTitle
} from '@/components/ui/dialog'

const props = defineProps<{
  open: boolean
  tool: ToolMeta | null
}>()
const emit = defineEmits<{
  'update:open': [open: boolean]
  confirmed: [keepData: boolean]
}>()

function cancel(): void {
  emit('update:open', false)
}
</script>

<template>
  <ui-dialog :open="open" @update:open="(v) => emit('update:open', v)">
    <ui-dialog-content class="max-w-md">
      <ui-dialog-title class="text-base font-semibold">删除工具</ui-dialog-title>
      <ui-dialog-description class="text-sm text-muted-foreground">
        确定删除工具「{{ props.tool?.title }}」吗？工具源码删除后不可恢复，请选择是否保留其持久化数据。
      </ui-dialog-description>
      <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
        <ui-button variant="ghost" size="sm" @click="cancel">
          取消
        </ui-button>
        <ui-button variant="outline" size="sm" @click="emit('confirmed', true)">
          仅删除工具（保留数据）
        </ui-button>
        <ui-button variant="destructive" size="sm" @click="emit('confirmed', false)">
          工具及数据一并删除
        </ui-button>
      </ui-dialog-footer>
    </ui-dialog-content>
  </ui-dialog>
</template>
