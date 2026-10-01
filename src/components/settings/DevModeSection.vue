<script setup lang="ts">
// 设置 · 开发者分区：开发者模式总开关 + 每个调试入口各自的开关。
//
// 总闸关着时，下面各页的开关一并禁用（此时它们不显示，逐个改也无意义）；
// 想只留其中几个时打开总闸再逐个关。状态读写与订阅见 src/lib/dev-mode-store.ts。
import { onMounted, onUnmounted, ref } from 'vue'
import { Switch as UiSwitch, SwitchThumb as UiSwitchThumb } from '@/components/ui/switch'
import { Button as UiButton } from '@/components/ui/button'
import {
  DEV_PAGES,
  getDevModeState,
  setDevMode,
  setDevPageEnabled,
  subscribeDevMode,
  type DevPageId,
} from '@/lib/dev-mode-store'

const enabled = ref(false)
const disabled = ref<DevPageId[]>([])
let unsubscribe: (() => void) | undefined

/** 某入口此刻是否显示（总开关 × 单页开关） */
function pageOn(id: DevPageId): boolean {
  return enabled.value && !disabled.value.includes(id)
}

async function onMaster(value: boolean): Promise<void> {
  enabled.value = value
  await setDevMode(value)
}

async function onPage(id: DevPageId, value: boolean): Promise<void> {
  const next = disabled.value.filter((x) => x !== id)
  if (!value) next.push(id)
  disabled.value = next
  await setDevPageEnabled(id, value)
}

onMounted(async () => {
  const state = await getDevModeState()
  enabled.value = state.enabled
  disabled.value = state.disabled
  // 订阅而非只读初值：同一开关在工作台别处被改（或将来多窗口）也要跟上
  unsubscribe = subscribeDevMode((s) => {
    enabled.value = s.enabled
    disabled.value = s.disabled
  })
})
onUnmounted(() => unsubscribe?.())

/** 通知图标（与工具栏同源，复用 auto-icons 构建生成的 icons/128.png） */
const NOTIFY_ICON = 'icons/128.png'

/** 发送一条测试通知，确认通知图标的显示效果（开发自测用） */
async function testNotify(): Promise<void> {
  await chrome.notifications.create('duoling:dev-test', {
    type: 'basic',
    iconUrl: NOTIFY_ICON,
    title: '哆灵',
    message: '这是一条测试通知，用于确认通知图标的显示效果。',
  })
}
</script>

<template>
  <div class="mx-auto max-w-3xl p-6">
    <div>
      <h3 class="text-base font-semibold">开发者</h3>
      <p class="mt-1 text-xs text-muted-foreground">
        调试界面与扩展本身时用到的开关，日常使用不需要打开。
      </p>
    </div>

    <div class="mt-6 divide-y divide-border overflow-hidden rounded-md border">
      <div class="flex items-center gap-4 px-4 py-3">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">开发者模式</p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            打开后工作台左侧才出现下面这些调试入口。
          </p>
        </div>
        <UiSwitch class="shrink-0" :model-value="enabled" @update:model-value="onMaster">
          <UiSwitchThumb />
        </UiSwitch>
      </div>

      <div
        v-for="page in DEV_PAGES"
        :key="page.id"
        class="flex items-center gap-4 px-4 py-3"
        :class="{ 'opacity-60': !enabled }"
      >
        <div class="min-w-0 flex-1">
          <p class="text-sm">{{ page.label }}</p>
        </div>
        <UiSwitch
          class="shrink-0"
          :disabled="!enabled"
          :model-value="pageOn(page.id)"
          @update:model-value="(value: boolean) => onPage(page.id, value)"
        >
          <UiSwitchThumb />
        </UiSwitch>
      </div>
    </div>

    <div class="mt-6 rounded-md border p-4">
      <p class="text-sm font-medium">通知</p>
      <p class="mt-0.5 text-xs text-muted-foreground">
        发送一条系统通知，确认通知图标（与工具栏同源）的显示效果。
      </p>
      <UiButton class="mt-3" variant="outline" @click="testNotify">
        发送测试通知
      </UiButton>
    </div>
  </div>
</template>
