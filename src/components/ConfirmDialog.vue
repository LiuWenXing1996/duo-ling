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
  /** 次要动作文案（可选）：给了就多一个按钮，排在「取消」与确认之间（如关闭确认里的「保存并关闭」） */
  alternativeText?: string
}>()

const emit = defineEmits<{
  'update:open': [open: boolean]
  confirm: []
  /** 次要动作（只有传了 alternativeText 才会触发）：动作完成后弹窗照常关闭，与确认一致 */
  alternative: []
}>()

function onConfirm(): void {
  emit('confirm')
  emit('update:open', false)
}

function onAlternative(): void {
  emit('alternative')
  emit('update:open', false)
}
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ props.title }}</DialogTitle>
        <DialogDescription v-if="props.description" class="whitespace-pre-line text-pretty">
          {{ props.description }}
        </DialogDescription>
      </DialogHeader>
      <!-- 默认插槽：给「必须看见」的补充信息留位置（description 是纯文本，只能承载平铺的说明）。
           调用方自己决定样式，组件不猜语气。 -->
      <slot />
      <DialogFooter class="gap-2">
        <button
          type="button"
          class="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          @click="emit('update:open', false)"
        >
          {{ props.cancelText ?? '取消' }}
        </button>
        <button
          v-if="props.alternativeText"
          type="button"
          class="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
          @click="onAlternative"
        >
          {{ props.alternativeText }}
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
