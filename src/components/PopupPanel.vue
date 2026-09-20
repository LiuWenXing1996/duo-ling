<script setup lang="ts">
// 工具栏图标 popup：浮层显示开关 + 两个跳转入口（对话侧栏 / 工作台标签页）。
// 浮层开关逻辑复用 float-panel-store（与设置页「网页浮层」分区同源），不重复实现存储。
// 「打开对话」经 chrome.sidePanel.open 唤起当前窗口的 side panel，随后关闭 popup；
// 「打开工作台」新建 workbench.html 标签页（与 ChatApp 内的入口同姿势，不带 hash 落默认面板）。
import { onMounted, ref } from 'vue'
import { Switch as UiSwitch, SwitchThumb as UiSwitchThumb } from '@/components/ui/switch'
import { Button as UiButton } from '@/components/ui/button'
import {
  getMasterEnabled,
  setMasterEnabled,
  isFloatEnabledForHost,
  setHostDisabled,
} from '@/lib/float-panel-store'

const master = ref(true)
const currentHost = ref('')
const currentEnabled = ref(true)

function safeHost(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

async function refresh(): Promise<void> {
  master.value = await getMasterEnabled()
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  currentHost.value = safeHost(tabs[0]?.url)
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

async function openConversation(): Promise<void> {
  const win = await chrome.windows.getCurrent()
  if (win.id !== undefined) {
    await chrome.sidePanel.open({ windowId: win.id })
  }
  window.close()
}

async function openWorkbench(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('workbench.html') })
  window.close()
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <div class="w-full px-4 py-3 space-y-3">
    <header class="flex items-center gap-2">
      <span class="text-sm font-semibold">哆灵</span>
      <span class="text-xs text-muted-foreground">浮窗设置</span>
    </header>

    <div class="flex items-center justify-between rounded-lg border border-border p-3">
      <div class="pr-3">
        <p class="text-sm font-medium">启用网页浮层</p>
        <p class="text-xs text-muted-foreground">关闭后所有网站都不显示悬浮按钮。</p>
      </div>
      <UiSwitch :model-value="master" @update:model-value="onMaster">
        <UiSwitchThumb />
      </UiSwitch>
    </div>

    <div class="flex items-center justify-between rounded-lg border border-border p-3">
      <div class="pr-3">
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

    <div class="grid grid-cols-2 gap-2">
      <UiButton @click="openConversation">打开对话</UiButton>
      <UiButton variant="outline" @click="openWorkbench">打开工作台</UiButton>
    </div>
  </div>
</template>
