// 设置 · 网页浮层分区：总开关 + 当前站点开关 + 已单独关闭的网站清单。
//
// 浮层是「默认全站开启、可单站关闭」——存储里只有**被关掉的站点**这一个集合（见
// lib/float-panel-store），没有「已开启清单」可列。所以下方清单呈现的是**偏离默认的那些
// 站点**，并配一句命中规则，让用户能核对「这个站为什么有 / 没有浮层」。
//
// 只读当前激活标签页的 hostname（设置页是扩展页，可查 chrome.tabs），
// 让用户按站点关闭在网页里悬浮的对话按钮。

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Switch as UiSwitch, SwitchThumb as UiSwitchThumb } from '@/components/ui/switch'
import { Button as UiButton } from '@/components/ui/button'
import { webHostname } from '@/lib/float-panel-host'
import {
  getMasterEnabled,
  setMasterEnabled,
  getDisabledSites,
  isFloatEnabledForHost,
  setHostDisabled,
  subscribeFloatSettings,
} from '@/lib/float-panel-store'

const master = ref(true)
const currentHost = ref('')
const currentEnabled = ref(true)
/** 被单独关掉浮层的站点（存储里就这一个集合） */
const disabledSites = ref<string[]>([])

/** 命中规则一句话：总开关关着时例外名单不生效，说清楚免得用户以为开关坏了 */
const ruleSummary = computed(() => {
  if (!master.value) return '总开关已关闭：浮层在所有网站都不显示。'
  if (disabledSites.value.length === 0) return '浮层在所有网站显示。'
  return '除下列网站外，所有网站都显示浮层。'
})

/** 清单按域名序呈现：存储里是关站的先后顺序，直接列出来读着没有稳定感 */
const siteList = computed(() => [...disabledSites.value].sort((a, b) => a.localeCompare(b)))

async function refresh(): Promise<void> {
  master.value = await getMasterEnabled()
  disabledSites.value = await getDisabledSites()
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  // 非普通网页一律视为「拿不到站点」：扩展页的 hostname 就是本扩展自己的 id（设置页自己
  // 就是扩展页），直接取出来会把它当成一个「网站」显示、还能写进站点禁用集合。
  // 判据与 popup 同源，见 lib/float-panel-host.ts
  currentHost.value = webHostname(tabs[0]?.url)
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

/** 把某站移出例外名单（恢复显示浮层）；清单靠订阅回拉，不在这里做乐观更新 */
async function restoreSite(host: string): Promise<void> {
  await setHostDisabled(host, false)
}

/** 订阅退订函数（卸载时收掉） */
let unsubscribe: (() => void) | null = null

onMounted(() => {
  void refresh()
  chrome.tabs.onActivated.addListener(refresh)
  unsubscribe = subscribeFloatSettings(() => void refresh())
})
onUnmounted(() => {
  chrome.tabs.onActivated.removeListener(refresh)
  unsubscribe?.()
  unsubscribe = null
})
</script>

<template>
  <div class="mx-auto max-w-3xl p-6">
    <div>
      <h3 class="text-base font-semibold">网页浮层</h3>
      <p class="mt-1 text-xs text-muted-foreground">
        在网页内显示一个悬浮对话按钮，点击打开对话界面。
      </p>
    </div>

    <!-- 两行设置与「关于」共用同一种信息行（左标题 + 说明，右侧控件），
         容器也是同一套 rounded-md border + divide-y，不是每行各自一张卡片 -->
    <div class="mt-6 divide-y divide-border overflow-hidden rounded-md border">
      <div class="flex items-center gap-4 px-4 py-3">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">启用网页浮层</p>
          <p class="mt-0.5 text-xs text-muted-foreground">关闭后所有网站都不显示悬浮按钮。</p>
        </div>
        <UiSwitch class="shrink-0" :model-value="master" @update:model-value="onMaster">
          <UiSwitchThumb />
        </UiSwitch>
      </div>

      <div class="flex items-center gap-4 px-4 py-3">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">当前网站显示浮层</p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            <template v-if="currentHost">{{ currentHost }}</template>
            <template v-else>当前标签页不是普通网页</template>
          </p>
        </div>
        <UiSwitch
          class="shrink-0"
          :disabled="!currentHost"
          :model-value="currentEnabled"
          @update:model-value="onCurrent"
        >
          <UiSwitchThumb />
        </UiSwitch>
      </div>
    </div>

    <!-- 例外名单：只列「被单独关掉的站点」（默认全站开启，没有正面清单可列）；
         标题下那句就是命中规则本身，免得用户只看清单猜不出不在清单里的站会怎样 -->
    <div class="mt-6">
      <p class="text-sm font-medium">已单独关闭的网站</p>
      <p class="mt-0.5 text-xs text-muted-foreground" data-testid="float-rule">
        {{ ruleSummary }}
      </p>

      <div class="mt-3 divide-y divide-border overflow-hidden rounded-md border">
        <p
          v-if="siteList.length === 0"
          class="px-4 py-3 text-sm text-muted-foreground"
          data-testid="float-sites-empty"
        >
          尚未单独关闭任何网站。
        </p>
        <div
          v-for="site in siteList"
          :key="site"
          class="flex items-center gap-4 px-4 py-3"
          data-testid="float-site-row"
        >
          <span class="min-w-0 flex-1 truncate text-sm">{{ site }}</span>
          <UiButton
            class="shrink-0"
            variant="outline"
            size="sm"
            data-testid="float-site-restore"
            @click="restoreSite(site)"
          >
            恢复显示
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
