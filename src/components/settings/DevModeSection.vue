<script setup lang="ts">
// 设置 · 开发者分区：开发者模式开关。
//
// 打开后工作台左侧导航才出现「AI 界面对话预览」这类只在调界面时用得上的入口；
// 关掉则整项隐藏，普通用户看到的导航保持干净。
// 开关状态读写与订阅见 src/lib/dev-mode-store.ts（键名只在那边一处）。
import { onMounted, onUnmounted, ref } from 'vue'
import { Switch as UiSwitch, SwitchThumb as UiSwitchThumb } from '@/components/ui/switch'
import { getDevMode, setDevMode, subscribeDevMode } from '@/lib/dev-mode-store'

const enabled = ref(false)
let unsubscribe: (() => void) | undefined

async function onToggle(value: boolean): Promise<void> {
  enabled.value = value
  await setDevMode(value)
}

onMounted(async () => {
  enabled.value = await getDevMode()
  // 订阅而非只读初值：同一开关在工作台别处被改（或将来多窗口）也要跟上
  unsubscribe = subscribeDevMode((v) => (enabled.value = v))
})
onUnmounted(() => unsubscribe?.())
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
            打开后工作台左侧出现「AI 界面对话预览」入口。
          </p>
        </div>
        <UiSwitch class="shrink-0" :model-value="enabled" @update:model-value="onToggle">
          <UiSwitchThumb />
        </UiSwitch>
      </div>
    </div>
  </div>
</template>
