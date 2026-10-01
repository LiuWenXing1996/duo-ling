<script setup lang="ts">
// 工具栏图标 popup：对话浮层入口 + 本页脚本 + 工作台入口 + 新版本提示。
// 「打开工作台」新建 workbench.html 标签页（与对话界面里的入口同姿势，不带 hash 落默认面板）。
// 「本页脚本」分区（PopupPageScripts）复用页面监控那条链路，只在普通网页上渲染 ——
// 非普通网页上 content script 注入不了、计数必然为空，与下面那条提示并列只会互相打架。
//
// 对话入口是**网页浮层**（content script 按需注入），所以这里对「挂不了浮层的页面」得给一句
// 说明：浏览器内部页 / 扩展页 / 应用商店上 content script 注入不了，用户在那些页面上打不开
// 不是装坏了。严格 CSP 站点同理也挂不上，但那要等页面里的 iframe 真的加载失败才知道
// —— popup 判不出来，那条由页面内的降级提示负责（见 content.ts）。
//
// 「用户脚本功能不可用」这张卡只在引擎开关关着时出现：那时角标已经亮着，用户顺着角标点进来
// 得有个能落脚的地方。开法按浏览器/版本分三支，一行说不清，故这里只给一句现状 + 一个入口，
// 步骤与「打开扩展管理页」都在工作台「引导」页（唯一权威说明处）。
import { computed, onMounted, ref } from 'vue'
import { TriangleAlert as UiTriangleAlert } from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import PopupNotifications from './PopupNotifications.vue'
import PopupPageScripts from './PopupPageScripts.vue'
import { webHostname } from '@/lib/float-panel-host'
import { readUpdateCheck, type UpdateCheckRecord } from '@/lib/update-check'
import { userscriptClient } from '@/lib/userscripts/ui-client'
import type { UserScriptsAvailability } from '@/lib/userscripts/types'
import { FLOAT_OPEN_REQUEST } from '@/shared/extension-ipc'

/** 当前标签页是不是普通网页（http/https）—— 只有这类页面 content script 能注入 */
const currentIsWebPage = ref(true)
/** 「打开」没打通时的说明（只在 popup 里显示，成功就直接关了） */
const openError = ref('')

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
 * 用户脚本引擎可用性（`null` = 没查到）。
 *
 * 刻意**不订阅** `availabilityChanged`：popup 只在点开后的这几秒里存在，而开开关的唯一路径是
 * 打开扩展管理页 —— 那一下立刻让 popup 失焦关闭。挂载时查一次就覆盖了它的整个生命周期。
 */
const availability = ref<UserScriptsAvailability | null>(null)

/**
 * 引擎不可用时的引导文案（可用 / 查不到都是空串 → 整张卡不渲染）。
 *
 * 「查不到」**不当作不可用**：SW 没响应（扩展正在更新）时宁可不提示，也不能把异常渲染成
 * 「你的开关没开」—— 那会让人去改一个本来就正常的设置。
 */
const unavailableGuide = computed(() =>
  availability.value && !availability.value.available ? availability.value.guideText : '',
)

async function refresh(): Promise<void> {
  update.value = await readUpdateCheck()
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  currentIsWebPage.value = webHostname(tabs[0]?.url) !== ''
  try {
    availability.value = await userscriptClient.availability()
  } catch {
    availability.value = null
  }
}

/**
 * 把当前页面的对话浮层调出来。
 *
 * 对话框平时不在页面里（content script 默认不往页面放 DOM，见 content.ts），这颗按钮是它的常规
 * 打开方式（另一条是页面右键菜单）。
 *
 * 收不到（页面在扩展更新前就打开、或在扩展管理页里单独禁掉了本站点的访问权）只能让用户刷新；
 * 这两种情况 popup 判不出来，所以文案不指向具体原因。失败时留在 popup 里把话说出来 ——
 * 关了就没地方说了。
 */
async function openFloatPanel(): Promise<void> {
  openError.value = ''
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = tabs[0]?.id
  // 读不到标签页时静默退场：这是 popup 与页面失联的异常态，给技术性报错只是噪音
  if (tabId == null) return

  try {
    await chrome.tabs.sendMessage(tabId, FLOAT_OPEN_REQUEST)
  } catch {
    openError.value = '页面还没接上哆灵，刷新页面后再试。'
    return
  }
  window.close()
}

async function openWorkbench(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('workbench.html') })
  window.close()
}

/**
 * 去工作台「引导」页：开引擎开关的分步说明都在那里（按浏览器/版本分三支，popup 塞不下）。
 * 带 `#/guide` 深链直达（与对话界面「查看开启引导」同一条路）。
 */
async function openGuide(): Promise<void> {
  await chrome.tabs.create({ url: `${chrome.runtime.getURL('workbench.html')}#/guide` })
  window.close()
}

/**
 * 打开 chrome://extensions 并带上本扩展 id：省掉「找入口 → 输地址 / 翻找卡片」这几步。
 *
 * 落点是**列表页**，不是详情页 —— 那个页面是 SPA，`?id=` 不会把路由切到详情页
 * （无头实测：tabs.create 不被拦、URL 里 id 保留，但页面停在 extensions-manager、
 * 无 extensions-detail-view）。最后那一下「点详情」没有程序化入口：chrome:// 页注入不了
 * 内容脚本，chrome.developerPrivate 也不对扩展开放。
 */
async function openExtensionsPage(): Promise<void> {
  await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })
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
    </header>

    <!-- 通知（进行中 + 跑完没看）：角标只报脚本运行数，会话的事在这里展开 -->
    <PopupNotifications />

    <!-- 引擎开关没开：角标亮着 `!`，点进来得有个落脚处。查询失败不渲染（宁缺勿错） -->
    <div
      v-if="unavailableGuide"
      class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
      data-testid="userscript-unavailable"
    >
      <p class="flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
        <UiTriangleAlert class="size-3.5 shrink-0" />
        用户脚本功能不可用
      </p>
      <p class="mt-1 text-xs leading-relaxed text-muted-foreground">{{ unavailableGuide }}</p>
      <UiButton
        class="mt-2 w-full"
        variant="outline"
        size="sm"
        data-testid="open-userscript-guide"
        @click="openGuide"
      >
        查看开启引导
      </UiButton>
    </div>

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
        <p class="text-sm font-medium">对话浮层</p>
        <p class="text-xs text-muted-foreground">在页面右下角打开对话。</p>
      </div>
      <UiButton
        :disabled="!currentIsWebPage"
        data-testid="open-float-panel"
        @click="openFloatPanel"
      >
        打开
      </UiButton>
    </div>
    <p
      v-if="openError"
      class="-mt-1 text-xs text-destructive"
      data-testid="open-float-error"
    >
      {{ openError }}
    </p>

    <PopupPageScripts v-if="currentIsWebPage" />

    <div class="grid grid-cols-2 gap-2">
      <UiButton variant="outline" @click="openWorkbench">打开工作台</UiButton>
      <UiButton variant="outline" data-testid="open-extensions-page" @click="openExtensionsPage">
        扩展管理页
      </UiButton>
    </div>
  </div>
</template>
