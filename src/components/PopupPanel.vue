<script setup lang="ts">
// 工具栏图标 popup：浮层显示开关 + 本页脚本 + 工作台入口 + 新版本提示。
// 浮层开关逻辑复用 float-panel-store（与设置页「网页浮层」分区同源），不重复实现存储。
// 「打开工作台」新建 workbench.html 标签页（与对话界面里的入口同姿势，不带 hash 落默认面板）。
// 「本页脚本」分区（PopupPageScripts）复用页面监控那条链路，只在普通网页上渲染 ——
// 非普通网页上 content script 注入不了、计数必然为空，与下面那条提示并列只会互相打架。
//
// 对话入口是**网页浮层**（content script 注入），所以这里对「挂不了浮层的页面」得给一句说明：
// 浏览器内部页 / 扩展页 / 应用商店上 content script 注入不了，用户在那些页面上看不到悬浮
// 按钮不是装坏了。严格 CSP 站点同理也挂不上，但那要等页面里的 iframe 真的加载失败才知道
// —— popup 判不出来，那条由页面内的降级提示负责（见 content.ts）。
import { computed, onMounted, ref } from 'vue'
import { Switch as UiSwitch, SwitchThumb as UiSwitchThumb } from '@/components/ui/switch'
import { Button as UiButton } from '@/components/ui/button'
import PopupPageScripts from './PopupPageScripts.vue'
import {
  getMasterEnabled,
  setMasterEnabled,
  isFloatEnabledForHost,
  setHostDisabled,
} from '@/lib/float-panel-store'
import { readUpdateCheck, type UpdateCheckRecord } from '@/lib/update-check'

const master = ref(true)
const currentHost = ref('')
const currentEnabled = ref(true)
/** 当前标签页是不是普通网页（http/https）—— 只有这类页面 content script 能注入 */
const currentIsWebPage = ref(true)

/**
 * 上次检查到的版本结论（SW 在开浏览器 / 安装更新时写入 duoling-app，这里只读）。
 * **刻意不在 popup 里发起检查**：它生命周期极短（点开即关），发网络请求会随窗口关闭被取消，
 * 还可能让打开瞬间卡一下——检查的时机归 SW 与设置页，这里只负责把已有结论露出来。
 */
const update = ref<UpdateCheckRecord | undefined>(undefined)

/** 有新版本时的结论（收窄成非空对象，模板里才能直接取 latest） */
const updateAvailable = computed(() =>
  update.value?.status.kind === 'update' ? update.value.status : null,
)

/**
 * 普通网页的 hostname；非普通网页（内部页 / 扩展页 / 应用商店）返回空串。
 *
 * 判据只能按 **scheme**。这些页面上扩展根本读不到 url —— manifest 里没有 `tabs` 权限，
 * 而 `<all_urls>` 不含 `chrome://` / `chrome-extension://` scheme（2026-09-21 无头实测：
 * `chrome://version` 与扩展自身页的 `tab.url` 都是 `undefined`，`tabs.query` 的其他字段正常）。
 * 旧版落到兜底文案「无法获取当前标签页地址」，用户看不出这里为什么没有浮层。
 *
 * 已知边界：`file://` 也走这条 —— 未开「允许访问文件网址」时扩展同样读不到它的 url
 * （读得到时 `hostname` 为空，照样不满足 `http/https`），而本地文件页**开了那个开关后是可
 * 注入的**，所以这条提示的文案要把它一起说到（见下方模板），不能写成「这些页面上都注入不了」。
 */
function webHost(url: string | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : ''
  } catch {
    return ''
  }
}

async function refresh(): Promise<void> {
  master.value = await getMasterEnabled()
  update.value = await readUpdateCheck()
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  currentHost.value = webHost(tabs[0]?.url)
  currentIsWebPage.value = currentHost.value !== ''
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

async function openWorkbench(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('workbench.html') })
  window.close()
}

/** 去 Release 页面：更新说明与产物下载都在那里 */
async function openRelease(): Promise<void> {
  const url = updateAvailable.value?.releaseUrl
  if (!url) return
  await chrome.tabs.create({ url })
  window.close()
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <div class="flex w-full flex-col gap-3 px-4 py-3">
    <header class="flex items-center gap-2">
      <span class="text-sm font-semibold">哆灵</span>
      <span class="text-xs text-muted-foreground">浮窗设置</span>
    </header>

    <!-- 仅在有新版本时出现：常态下 popup 保持原样，不新增噪音 -->
    <div
      v-if="updateAvailable"
      class="rounded-lg border border-border p-3"
      data-testid="update-available"
    >
      <p class="text-sm font-medium">有新版本 v{{ updateAvailable.latest }}</p>
      <p class="mt-0.5 text-xs text-muted-foreground">当前 v{{ update?.current }}</p>
      <UiButton class="mt-2 w-full" variant="outline" size="sm" @click="openRelease">
        去下载
      </UiButton>
    </div>

    <!-- 挂不了浮层的页面：说清原因，别让用户以为装坏了 -->
    <p
      v-if="!currentIsWebPage"
      class="rounded-lg border border-border bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground"
      data-testid="float-unsupported"
    >
      当前页面不能显示浮层：浏览器内部页、扩展页、应用商店上都注入不了；本地文件页需开启「允许访问文件网址」才可用。
    </p>

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
          <template v-else>当前页面不是普通网页</template>
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

    <PopupPageScripts v-if="currentIsWebPage" />

    <UiButton class="w-full" variant="outline" @click="openWorkbench">打开工作台</UiButton>
  </div>
</template>
