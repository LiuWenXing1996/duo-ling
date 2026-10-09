<script setup lang="ts">
// popup = 点工具栏图标弹出的面板（**纯配置面板，不装 window.api**，也不承载对话）。
//
// 主体是两个区块，数据来自同一条 page:overview 命令（SW 侧一处聚合，见 shared/extension-ipc）：
//   · 「当前页面」（PopupCurrentPage）：本页在跑哪些脚本 + 这条页面的对话浮层入口与回话状态；
//   · 「其他页面」（PopupOtherPages）：其他打开的页面各自的脚本与会话，点一行切过去。
// popup 只活几秒，故取一次快照即可，不维持推送通道 —— 页面上的脚本在 popup 打开前就已经登记好了。
//
// 另有几张条件卡（都沿用既有实现）：「用户脚本功能不可用」只在引擎开关关着时出现（那时角标已经
// 亮着，用户顺着角标点进来得有个能落脚的地方；开法分浏览器/版本三支，一行说不清，故这里只给一句
// 现状 + 一个入口，步骤与「打开扩展管理页」都在工作台「引导」页）；新版本卡只在真有新版本时出现。
import { computed, onMounted, ref } from 'vue'
import { PanelsTopLeft as UiPanelsTopLeft, TriangleAlert as UiTriangleAlert } from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import PopupCurrentPage from './PopupCurrentPage.vue'
import PopupOtherPages from './PopupOtherPages.vue'
import { EXTENSION_NAME } from '@/lib/extension-identity'
import { probeContentScript, webHostname } from '@/lib/float-panel-host'
import { readUpdateCheck, type UpdateCheckRecord } from '@/lib/update-check'
import { userscriptClient } from '@/lib/userscripts/ui-client'
import type { UserScriptsAvailability } from '@/lib/userscripts/types'
import type { PageOverviewTab, RuntimeRequest, RuntimeResponse } from '@/shared/extension-ipc'

/** 当前标签页是不是普通网页（http/https）—— 探活回话之前的初值，判「能不能注入」以 contentScriptPresent 为准 */
const currentIsWebPage = ref(true)
/** 内容脚本探活结论（null = 还没问回来），判据见 lib/float-panel-host.ts */
const contentScriptPresent = ref<boolean | null>(null)
/** 当前标签页 id 与地址（认领概览里「哪一行是我」） */
const currentTabId = ref<number | null>(null)
const currentUrl = ref('')
/** 全部标签页的概览（含当前页；命令失败 / SW 不在时是空表，两块都退化成空态） */
const overview = ref<PageOverviewTab[]>([])

/**
 * 当前页面能不能跑脚本 / 挂浮层：以探活为准 —— scheme 判不出三类（应用商店、站点访问权限设成
 * 「点击时」的站点、开了文件访问的本地文件页，见 lib/float-panel-host.ts）。探活回话之前用
 * scheme 判据垫着，否则普通网页上首帧会闪一下「不能运行脚本」。
 */
const injectable = computed(() => contentScriptPresent.value ?? currentIsWebPage.value)

/** 当前页的概览；不在概览里（内部页 / 扩展页）时为 null，区块按空态渲染 */
const currentTab = computed(() => overview.value.find((t) => t.tabId === currentTabId.value) ?? null)
/** 其他页面（概览按标签页顺序给出，这里只摘掉自己那一行） */
const otherTabs = computed(() => overview.value.filter((t) => t.tabId !== currentTabId.value))

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

/** 问一次命令面：SW 不在（扩展正在更新 / 刚被禁用）时静默返回 undefined，面板按空态渲染 */
async function ask<T>(request: RuntimeRequest): Promise<T | undefined> {
  try {
    const res = (await chrome.runtime.sendMessage(request)) as RuntimeResponse<T> | undefined
    return res?.ok ? res.data : undefined
  } catch {
    return undefined
  }
}

async function refresh(): Promise<void> {
  update.value = await readUpdateCheck()
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = tabs[0]?.id
  currentTabId.value = tabId ?? null
  currentUrl.value = tabs[0]?.url ?? ''
  currentIsWebPage.value = webHostname(tabs[0]?.url) !== ''
  // 取不到标签页（异常态）保持 null：交给 scheme 判据垫着，好过断言「注入不了」
  contentScriptPresent.value = tabId == null ? null : await probeContentScript(tabId)
  try {
    availability.value = await userscriptClient.availability()
  } catch {
    availability.value = null
  }
  overview.value = (await ask<PageOverviewTab[]>({ kind: 'page:overview' })) ?? []
}

/** 打开工作台：新建 workbench.html 标签页（不带 hash，落默认面板） */
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
      <span class="text-sm font-semibold">{{ EXTENSION_NAME }}</span>
    </header>

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

    <PopupCurrentPage :host="webHostname(currentUrl)" :injectable="injectable" :tab="currentTab" />

    <PopupOtherPages :tabs="otherTabs" />

    <!-- 出口：内容都在上面，这一颗是「去工作台」——点一下就关窗走人，文字直接可见、不藏进 tooltip -->
    <UiButton variant="outline" class="w-full" data-testid="open-workbench" @click="openWorkbench">
      <UiPanelsTopLeft class="size-4" />
      打开工作台
    </UiButton>
  </div>
</template>
