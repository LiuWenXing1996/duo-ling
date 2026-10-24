<script setup lang="ts">
// 分组弹窗：新建 / 重命名 / 删除确认 / 移动到分组
import { Check as UiCheck } from '@lucide/vue'
import { Button as UiButton } from '@duoling/ui/components/ui/button'
import {
  Dialog as UiDialog,
  DialogContent as UiDialogContent,
  DialogDescription as UiDialogDescription,
  DialogFooter as UiDialogFooter,
  DialogTitle as UiDialogTitle,
} from '@duoling/ui/components/ui/dialog'
import { Input as UiInput } from '@duoling/ui/components/ui/input'
import type { GroupsState } from './use-groups'

defineProps<{
  g: GroupsState
}>()
</script>

<template>
  <ui-dialog
    :open="g.groupDialogOpen"
    @update:open="
      (v: boolean) => {
        if (!v) g.groupDialogOpen = false
      }
    "
  >
    <ui-dialog-content class="max-w-md">
      <ui-dialog-title class="text-base font-semibold">
        {{ g.groupDialogTarget ? '重命名分组' : '新建分组' }}
      </ui-dialog-title>
      <ui-dialog-description class="text-sm text-muted-foreground">
        {{
          g.groupDialogTarget
            ? '修改该分组的显示名称，不影响其下脚本。'
            : '给一组脚本起个名字，方便在列表里归类。'
        }}
      </ui-dialog-description>
      <div class="mt-3">
        <ui-input
          v-model="g.groupDialogName"
          :placeholder="g.groupDialogTarget ? '分组名称' : '如：购物助手'"
          aria-label="分组名称"
          spellcheck="false"
          autocomplete="off"
          @keydown.enter="g.confirmGroupDialog"
        />
      </div>
      <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
        <ui-button variant="ghost" size="sm" @click="g.groupDialogOpen = false"> 取消 </ui-button>
        <ui-button size="sm" :disabled="!g.groupDialogName.trim()" @click="g.confirmGroupDialog">
          {{ g.groupDialogTarget ? '保存' : '创建' }}
        </ui-button>
      </ui-dialog-footer>
    </ui-dialog-content>
  </ui-dialog>

  <ui-dialog
    :open="!!g.removeGroupTarget"
    @update:open="
      (v: boolean) => {
        if (!v) g.removeGroupTarget = null
      }
    "
  >
    <ui-dialog-content class="max-w-md">
      <ui-dialog-title class="text-base font-semibold">删除分组</ui-dialog-title>
      <ui-dialog-description class="text-sm text-muted-foreground">
        删除分组「{{
          g.groupById.get(g.removeGroupTarget ?? '')?.name ?? ''
        }}」后，其下脚本将退回「未分组」。此操作不可撤销。
      </ui-dialog-description>
      <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
        <ui-button variant="ghost" size="sm" @click="g.removeGroupTarget = null"> 取消 </ui-button>
        <ui-button size="sm" variant="destructive" @click="g.confirmRemoveGroup"> 删除 </ui-button>
      </ui-dialog-footer>
    </ui-dialog-content>
  </ui-dialog>

  <ui-dialog
    :open="!!g.moveTarget"
    @update:open="
      (v: boolean) => {
        if (!v) g.moveTarget = null
      }
    "
  >
    <ui-dialog-content class="max-w-md">
      <ui-dialog-title class="text-base font-semibold">移动到分组</ui-dialog-title>
      <ui-dialog-description class="text-sm text-muted-foreground">
        「{{ g.moveTarget?.name }}」归入哪个分组？只影响列表里的归类，脚本源码与匹配规则不变。
      </ui-dialog-description>
      <div class="mt-3 flex max-h-64 flex-col gap-1 overflow-y-auto">
        <ui-button
          v-for="opt in g.moveOptions"
          :key="opt.id || '__ungrouped__'"
          variant="ghost"
          size="sm"
          class="w-full justify-start"
          :disabled="opt.current"
          @click="g.confirmMove(opt.id)"
        >
          <span class="truncate">{{ opt.name }}</span>
          <ui-check v-if="opt.current" class="ml-auto size-3.5 shrink-0" />
        </ui-button>
        <p v-if="!g.groups.length" class="px-1 pt-1 text-xs text-muted-foreground">
          还没有分组。可先在上方「新建分组」创建一个。
        </p>
      </div>
      <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
        <ui-button variant="ghost" size="sm" @click="g.moveTarget = null">取消</ui-button>
      </ui-dialog-footer>
    </ui-dialog-content>
  </ui-dialog>
</template>
