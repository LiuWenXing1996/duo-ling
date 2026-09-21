// 设置 · 网页浮层分区：总开关 + 当前站点开关。
// 只读当前激活标签页的 hostname（设置页是扩展页，可查 chrome.tabs），
// 让用户按站点关闭在网页里悬浮的对话按钮。

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { Switch as UiSwitch, SwitchThumb as UiSwitchThumb } from '@/components/ui/switch'
import {
  getMasterEnabled,
  setMasterEnabled,
  isFloatEnabledForHost,
  setHostDisabled,
} from '@/lib/float-panel-store'

const master = ref(true)
const currentHost = ref('')
const currentEnabled = ref(true)

async function refresh(): Promise<void> {
  master.value = await getMasterEnabled()
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tabs[0]?.url
  if (url) {
    try {
      currentHost.value = new URL(url).hostname
    } catch {
      currentHost.value = ''
    }
  } else {
    currentHost.value = ''
  }
  if (currentHost.value) {
    currentEnabled.value = await isFloatEnabledForHost(currentHost.value)
  }
}

async function onMaster(value: boolean): Promise<void> {
  master.value = value
  await setMasterEnabled(value)
}

async function onCurrent(value: boolean): Promise<void> {
  if (!currentHost.value) return
  currentEnabled.value = value
  // value=true 表示在当站显示 → 取消禁用
  await setHostDisabled(currentHost.value, !value)
}

onMounted(() => {
  void refresh()
  chrome.tabs.onActivated.addListener(refresh)
})
onUnmounted(() => {
  chrome.tabs.onActivated.removeListener(refresh)
})
</script>

<template>
  <div class="space-y-6">
    <div>
      <h2 class="text-lg font-semibold mb-1">网页浮层</h2>
      <p class="text-sm text-muted-foreground">
        在网页内显示一个悬浮对话按钮，点击打开对话界面。
      </p>
    </div>

    <div class="flex items-center justify-between rounded-lg border border-border p-4">
      <div class="pr-4">
        <p class="text-sm font-medium">启用网页浮层</p>
        <p class="text-xs text-muted-foreground">关闭后所有网站都不显示悬浮按钮。</p>
      </div>
      <UiSwitch :model-value="master" @update:model-value="onMaster">
        <UiSwitchThumb />
      </UiSwitch>
    </div>

    <div class="flex items-center justify-between rounded-lg border border-border p-4">
      <div class="pr-4">
        <p class="text-sm font-medium">当前网站显示浮层</p>
        <p class="text-xs text-muted-foreground">
          <template v-if="currentHost">{{ currentHost }}</template>
          <template v-else>无法获取当前标签页地址</template>
        </p>
      </div>
      <UiSwitch
        :disabled="!currentHost"
        :model-value="currentEnabled"
        @update:model-value="onCurrent"
      >
        <UiSwitchThumb />
      </UiSwitch>
    </div>
  </div>
</template>
