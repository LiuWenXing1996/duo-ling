<script setup lang="ts">
// 通用确认弹窗（shadcn Dialog 封装）：替代原生 window.confirm。
// 受控用法：v-model:open 控制显隐，@confirm 里执行动作（弹窗自行关闭）。
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const props = defineProps<{
  open: boolean
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  /** 危险操作：确认按钮用红色系 */
  danger?: boolean
}>()

const emit = defineEmits<{
  'update:open': [open: boolean]
  confirm: []
}>()

function onConfirm(): void {
  emit('confirm')
  emit('update:open', false)
}
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ props.title }}</DialogTitle>
        <DialogDescription v-if="props.description" class="whitespace-pre-line">
          {{ props.description }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter class="gap-2">
        <button
          type="button"
          class="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          @click="emit('update:open', false)"
        >
          {{ props.cancelText ?? '取消' }}
        </button>
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-sm font-medium text-primary-foreground"
          :class="props.danger ? 'bg-destructive hover:bg-destructive/90' : 'bg-primary hover:bg-primary/90'"
          @click="onConfirm"
        >
          {{ props.confirmText ?? '确定' }}
        </button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
