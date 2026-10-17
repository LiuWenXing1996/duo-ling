<script setup lang="ts">
// popup = 点工具栏图标弹出的面板（**纯配置面板，不装 window.api**，也不承载对话）。
//
// 主体是两个区块，数据来自同一条 page:overview 命令（SW 侧一处聚合，见 shared/extension-ipc）：
//   · 「当前页面」（PopupCurrentPage）：本标签页的两个按页开关（常显的子卡，可就地开与关）——
//     接口录制、活动记录 —— + 本页在跑哪些脚本 + 这条页面的对话浮层入口与回话状态；
//   · 「其他页面」（PopupOtherPages）：其他打开的页面各自的脚本与会话，点一行切过去。
// popup 只活几秒，故取一次快照即可，不维持推送通道 —— 页面上的脚本在 popup 打开前就已经登记好了。
//
// 标题行右侧两个图标入口（说明挂在悬停提示上）：设置（工作台「设置」页）、打开工作台 —— 都是
// 点一下创建标签页并关窗，本面板不承载它们的内容。
//
// 另有几张条件卡（都沿用既有实现）：「用户脚本功能不可用」只在引擎开关关着时出现（那时角标已经
// 亮着，用户顺着角标点进来得有个能落脚的地方；开法分浏览器/版本三支，一行说不清，故这里只给一句
// 现状 + 一个入口，步骤与「打开扩展管理页」都在工作台「引导」页）；新版本卡只在真有新版本时出现。
import { computed, onMounted, ref } from 'vue'
import {
  PanelsTopLeft as UiPanelsTopLeft,
  Settings as UiSettings,
  TriangleAlert as UiTriangleAlert,
} from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger,
} from '@/components/ui/tooltip'
import PopupCurrentPage from './PopupCurrentPage.vue'
import PopupOtherPages from './PopupOtherPages.vue'
import { EXTENSION_NAME } from '@duoling/shared'
import { readInjectedBuildInfo } from '@/lib/build-info'
import { webHostname } from '@/lib/web-hostname'
import { readUpdateCheck, type UpdateCheckRecord } from '@/lib/update-check'
import { userscriptClient } from '@/lib/userscripts/ui-client'
import type { UserScriptsAvailability } from '@duoling/shared'
import type { PageOverviewTab, RuntimeRequest } from '@/shared/extension-ipc'
import { ipcRequest } from '@/shared/ipc-bus'

/** 当前标签页 id 与地址（认领概览里「哪一行是我」） */
const currentTabId = ref<number | null>(null)
const currentUrl = ref('')
/**
 * 当前页的站点名（拿不到 url 的内部页 / 扩展页上是空串，判据见 lib/web-hostname.ts）。
 *
 * 它同时是「这一页能不能挂浮层」的判据 —— 下面几处子组件都按「有站点名 = 普通网页」用。
 */
const currentHost = computed(() => webHostname(currentUrl.value))

/** 当前构建版本（含预发布标签）：构建期注入，源码里没有第二处版本真相源；缺失（如测试环境）时隐藏 */
const version = readInjectedBuildInfo()?.version ?? ''
/** 全部标签页的概览（含当前页；命令失败 / SW 不在时是空表，两块都退化成空态） */
const overview = ref<PageOverviewTab[]>([])

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
    return await ipcRequest<T>(request)
  } catch {
    return undefined
  }
}

async function refresh(): Promise<void> {
  update.value = await readUpdateCheck()
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = tabs[0]?.id
  currentTabId.value = tabId ?? null
  // 内部页 / 扩展页上扩展读不到 url（manifest 无 tabs 权限）—— 那种页面就是这个空串
  currentUrl.value = tabs[0]?.url ?? ''
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

/**
 * 去工作台「设置」页：带 `#/settings` 深链直达（与对话界面顶栏那颗设置按钮同一条路）。
 * popup 只给入口不给设置项 —— 那些表单的宽度与校验都不适合塞进一个几秒就关的小窗。
 */
async function openSettings(): Promise<void> {
  await chrome.tabs.create({ url: `${chrome.runtime.getURL('workbench.html')}#/settings` })
  window.close()
}

/** 去 Release 页面：更新说明与产物下载都在那里 */
async function openRelease(): Promise<void> {
  const url = updateAvailable.value?.releaseUrl
  if (!url) return
  await chrome.tabs.create({ url })
  window.close()
}

/**
 * 开关切换成功后，就地更新那一行的记录标。
 *
 * 判据是 tab 维度，故只动这一行（同站点的其他标签页各开各的，不该跟着变）。命令即真相，
 * 不再回查一遍概览（popup 只活几秒，重跑会把几条查询再来一遍）。
 */
function onTabRecordingChanged(tabId: number, recording: boolean): void {
  const row = overview.value.find((t) => t.tabId === tabId)
  if (row) row.tabRecording = recording
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <div class="flex w-full flex-col gap-3 px-4 py-3">
    <!--
      两个去处按图标排在标题右侧：popup 的版面留给「这一页在跑什么」，设置与工作台都是点一下
      就关窗走人的门，一句话的说明挂在各自悬停提示上即可，不必占行。
      提示朝下弹：这一行贴着 popup 顶边，朝上的浮层没有落脚空间。
    -->
    <header class="flex items-center justify-between gap-2">
      <div class="flex min-w-0 items-baseline gap-1.5">
        <span class="text-sm font-semibold">{{ EXTENSION_NAME }}</span>
        <span
          v-if="version"
          class="shrink-0 text-xs text-muted-foreground"
          data-testid="popup-version"
        >
          v{{ version }}
        </span>
      </div>
      <div class="flex items-center gap-0.5">
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <UiButton
                variant="ghost"
                size="icon"
                class="size-7 shrink-0"
                aria-label="设置"
                data-testid="open-settings"
                @click="openSettings"
              >
                <UiSettings class="size-4" />
              </UiButton>
            </ui-tooltip-trigger>
            <ui-tooltip-content side="bottom">设置</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <UiButton
                variant="ghost"
                size="icon"
                class="size-7 shrink-0"
                aria-label="打开工作台"
                data-testid="open-workbench"
                @click="openWorkbench"
              >
                <UiPanelsTopLeft class="size-4" />
              </UiButton>
            </ui-tooltip-trigger>
            <ui-tooltip-content side="bottom">打开工作台</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
      </div>
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

    <PopupCurrentPage
      :host="currentHost"
      :tab="currentTab"
      @tab-recording-changed="onTabRecordingChanged"
    />

    <PopupOtherPages :tabs="otherTabs" />
  </div>
</template>
