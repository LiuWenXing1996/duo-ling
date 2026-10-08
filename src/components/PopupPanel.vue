<script setup lang="ts">
// 「打开会话」= 把当前页的对话浮层调出来。对话框平时不在页面里（content script 默认不往页面放
// DOM，见 content.ts），这颗按钮是它的常规打开方式（另一条是页面右键菜单）。
// 注入不了内容脚本的页面（浏览器内部页 / 扩展页 / 应用商店 / 站点权限设成「点击时」的站点…）
// 上打不开不是装坏了 —— 这个原因挂在按钮的 tooltip 上（不可用时按钮禁灰、提示改显原因），
// 不单独占一行。
// 严格 CSP 站点同理也挂不上，但那要等页面里的 iframe 真的加载失败才知道 —— popup 判不出来，
// 那条由页面内的降级提示负责（见 content.ts）。
//
// 「本页脚本」分区（PopupPageScripts）复用页面监控那条链路，任何界面都渲染 —— 能否注入只决定
// 它给数量还是给原因：注入不了的页面上计数必然为空，藏起整块会让用户以为没有这个功能，
// 故保留卡片、摘要行改说原因（判据由本组件传入）。
//
// 「用户脚本功能不可用」这张卡只在引擎开关关着时出现：那时角标已经亮着，用户顺着角标点进来
// 得有个能落脚的地方。开法按浏览器/版本分三支，一行说不清，故这里只给一句现状 + 一个入口，
// 步骤与「打开扩展管理页」都在工作台「引导」页（唯一权威说明处）。
import { computed, onMounted, ref } from 'vue'
import {
  MessageSquare as UiMessageSquare,
  PanelsTopLeft as UiPanelsTopLeft,
  TriangleAlert as UiTriangleAlert,
} from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger,
} from '@/components/ui/tooltip'
import PopupPageScripts from './PopupPageScripts.vue'
import { EXTENSION_NAME } from '@/lib/extension-identity'
import { probeContentScript, webHostname } from '@/lib/float-panel-host'
import { readUpdateCheck, type UpdateCheckRecord } from '@/lib/update-check'
import { userscriptClient } from '@/lib/userscripts/ui-client'
import type { UserScriptsAvailability } from '@/lib/userscripts/types'
import { FLOAT_OPEN_REQUEST } from '@/shared/extension-ipc'

/** 当前标签页是不是普通网页（http/https）—— 探活回话之前的初值，判「能不能注入」以 contentScriptPresent 为准 */
const currentIsWebPage = ref(true)
/** 内容脚本探活结论（null = 还没问回来），判据见 lib/float-panel-host.ts */
const contentScriptPresent = ref<boolean | null>(null)
/** 「打开」没打通时的说明（只在 popup 里显示，成功就直接关了） */
const openError = ref('')

/**
 * 当前页面能不能跑脚本 / 挂浮层：以探活为准 —— scheme 判不出三类（应用商店、站点访问权限设成
 * 「点击时」的站点、开了文件访问的本地文件页，见 lib/float-panel-host.ts）。探活回话之前用
 * scheme 判据垫着，否则普通网页上首帧会闪一下「不能运行脚本」。
 */
const injectable = computed(() => contentScriptPresent.value ?? currentIsWebPage.value)

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

/** 「打开会话」禁用时的悬停提示：一句话点明事实即可，原因细节不展开（按钮上已有文字标签，可用时不弹提示） */
const openFloatHint = '当前页面不能显示对话浮层'

async function refresh(): Promise<void> {
  update.value = await readUpdateCheck()
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = tabs[0]?.id
  currentIsWebPage.value = webHostname(tabs[0]?.url) !== ''
  // 取不到标签页（异常态）保持 null：交给 scheme 判据垫着，好过断言「注入不了」
  contentScriptPresent.value = tabId == null ? null : await probeContentScript(tabId)
  try {
    availability.value = await userscriptClient.availability()
  } catch {
    availability.value = null
  }
}

/**
 * 把当前页面的对话浮层调出来。
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
    openError.value = `页面还没接上${EXTENSION_NAME}，刷新页面后再试。`
    return
  }
  window.close()
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

    <PopupPageScripts :injectable="injectable" />

    <!--
      入口按钮：沉到 popup 底部、各占一半行宽 —— 上面的通知 / 引导 / 本页脚本都是「状态」，
      这两枚是「出口」，动线顺着看完状态再出手；等宽用 grid 两列。都是「点一下就关窗走人」
      的动作，文字直接可见，不藏进 tooltip。「打开会话」挂不上浮层时禁用，原因由 hover
      提示承担（可用时不弹提示，按钮上的文字已经说明它干什么）；按钮已在窗口底部，提示
      向上弹出避免被窗沿裁掉。按钮外套 span 是必需的：Tooltip 的触发器只能落在 span 上，
      禁用按钮不收指针事件，直接套在按钮上会让整枚提示哑掉（reka-ui 的 as-child 只认
      最外层那个元素）。
    -->
    <div class="grid grid-cols-2 gap-2">
      <ui-tooltip-provider>
        <ui-tooltip>
          <ui-tooltip-trigger as-child>
            <span class="inline-flex w-full">
              <ui-button
                variant="outline"
                class="w-full"
                :disabled="!injectable"
                data-testid="open-float-panel"
                @click="openFloatPanel"
              >
                <ui-message-square class="size-4" />
                打开会话
              </ui-button>
            </span>
          </ui-tooltip-trigger>
          <ui-tooltip-content v-if="!injectable" side="top" class="max-w-64">
            {{ openFloatHint }}
          </ui-tooltip-content>
        </ui-tooltip>
      </ui-tooltip-provider>

      <ui-button
        variant="outline"
        class="w-full"
        data-testid="open-workbench"
        @click="openWorkbench"
      >
        <ui-panels-top-left class="size-4" />
        打开工作台
      </ui-button>
    </div>

    <p v-if="openError" class="text-xs text-destructive" data-testid="open-float-error">
      {{ openError }}
    </p>
  </div>
</template>
