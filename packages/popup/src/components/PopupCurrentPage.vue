<script setup lang="ts">
// 判据都不在这里现算：PopupPanel 挂载时经一条 page:overview 命令取回，再传进来 —— popup 是纯
// 展示面板（不直连会话库），聚合口径统一在 SW 侧一处（见 shared/extension-ipc
// 的 PageOverviewTab）。popup 只活几秒，故取一次快照即可，不维持推送通道。
import { computed, ref } from 'vue'
import {
  ChevronDown as UiChevronDown,
  ChevronRight as UiChevronRight,
  List as UiList,
} from '@lucide/vue'
import { Badge as UiBadge } from '@duoling/ui/components/ui/badge'
import { Button as UiButton } from '@duoling/ui/components/ui/button'
import { Switch as UiSwitch, SwitchThumb as UiSwitchThumb } from '@duoling/ui/components/ui/switch'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger,
} from '@duoling/ui/components/ui/tooltip'
import { type PageOverviewTab } from '@duoling/shared'
import { ipcRequest } from '@duoling/shared'
import { errorText } from '@duoling/ui/lib/format'
import PopupChat from './PopupChat.vue'

const props = defineProps<{
  /** 当前页的站点名（拿不到 url 的内部页上是空串，见 lib/web-hostname.ts） */
  host: string
  /** 当前标签页的概览；null = 这一页不在概览里（内部页 / 扩展页 / 读不到标签页） */
  tab: PageOverviewTab | null
  chatTabId: number | null
  canChat: boolean
}>()

/** 开关切换成功后上抛给父组件（popup 不维持推送通道，由父组件就地更新这一行的状态位） */
const emit = defineEmits<{
  tabRecordingChanged: [tabId: number, recording: boolean]
}>()

const scriptsOpen = ref(false)

const chatDisabledHint = '当前页面不能显示对话'

const isWebPage = computed(() => props.host !== '')

const scripts = computed(() => props.tab?.scripts ?? [])
/**
 * 这一页上在用的扩展内置件（只读透出）。
 *
 * 它们不是用户脚本（没有源码 / 启停 / 报错），故**不进**上面的计数与列表 —— 混进去会让
 * 「N 个在运行」这个数对不上列表行数。单列一组弱化行，尾标「内置」点明归属。
 */
const builtins = computed(() => props.tab?.builtins ?? [])
const errorCount = computed(() => scripts.value.reduce((n, s) => n + s.errorCount, 0))

/** 这个标签页是否在记活动 —— 记录是被动的，靠它决定要不要给这页的运行带上标签页归属 */
const tabRecording = computed(() => props.tab?.tabRecording === true)

/**
 * 这个标签页能不能用这枚开关：要在概览里（拿得到 tabId）且是普通网页（拿得到站点名）。
 * 内部页 / 扩展页两样都缺 —— 那种页面上开关禁灰，状态位改说原因；脚本在那类页面上也根本不会跑，
 * 开了没东西可记。
 */
const canRecord = computed(() => props.tab != null && isWebPage.value)

/** 开关在途（禁灰，防连点重复发命令） */
const toggleBusy = ref(false)
/** 开关失败的说明（成功就不必说，状态位自己会变） */
const toggleError = ref('')

/**
 * 刚被扳开、还没刷新过页面。
 *
 * 接口录制那半是声明式注册（匹配粒度是站点、钩子在 `document_start` 挂），扳开关时页面早已跑完 ——
 * 首屏请求录不到，得重载。这不是缺陷，是「不刷新就注入不了钩子」的必然结果，故当面说清，
 * 免得用户以为开关一扳就在录了。活动记录那半不受它影响，拨开即生效。
 */
const justEnabled = ref(false)

/** 没开时状态位的说法：能开就说「未开启」，不能开就说清是这一档 */
const idleLabel = computed(() => (canRecord.value ? '未开启' : '当前页面不支持'))

/**
 * 脚本卡头部行的计数文案。
 *
 * 「不能运行」只在**确无运行记录**时才说：记录非空就照常给数量。两样通常互斥（只有普通网页会
 * 进概览、会有记录），唯一例外是 `file://` 那种 scheme 判不出来的页面 —— 这一挡保证不会出现
 * 「说不能运行、却又能列出 2 条」的自相矛盾。
 */
const scriptSummary = computed(() => {
  if (scripts.value.length) return `${scripts.value.length} 个在运行`
  return isWebPage.value ? '本页没有运行中的脚本' : '当前页面不能运行脚本'
})

/**
 * 打开工作台的脚本列表：workbench.html 不带 hash 时落默认面板（脚本列表），
 * 与标题行「打开工作台」同一条路；点了就关窗 —— 管理动作都在工作台里做。
 */
async function openScriptManager(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('workbench.html') })
  window.close()
}

/**
 * 扳动这一页的开关（**唯一的一枚**）。
 *
 * 判据落在**这一个标签页**上，命令只带 tabId，地址由 SW 现取。它同时开两件事：给这页建 / 开
 * 存续行（「活动历史」里立刻就能看到它），以及这一页的接口录制。开启必须由人发起 —— AI 工具只能
 * 出同意卡，浮层那张卡与这里走同一条命令，只是挪到一个不必先打开浮层就能按到的地方。
 *
 * 开与关都会给这一页的时间线留一条（开始记录 / 结束记录），「哪一段在记」在那边看得见。
 * 关掉不清任何内容：已录接口、存续行与运行记录都留着（清理在「活动历史」面板里）。
 * 失败时留在面板里把话说出来（与「打开会话」同款：关了就没地方说了）；成功上抛给父组件。
 */
async function toggleTabActivity(next: boolean): Promise<void> {
  const tabId = props.tab?.tabId
  if (toggleBusy.value || tabId == null) return
  toggleBusy.value = true
  toggleError.value = ''
  try {
    await ipcRequest<unknown>(
      next
        ? { kind: 'userscript:tabActivityEnable', tabId }
        : { kind: 'userscript:tabActivityDisable', tabId },
    )
    emit('tabRecordingChanged', tabId, next)
    justEnabled.value = next
  } catch (e) {
    toggleError.value = errorText(e)
    // 这一发没成，别让上一次成功留下的「刚开启」提示继续挂在卡片上
    justEnabled.value = false
  } finally {
    toggleBusy.value = false
  }
}
</script>

<template>
  <div class="rounded-lg border border-border" data-testid="popup-current-page">
    <div class="flex items-center gap-2 border-b border-border px-3 py-2">
      <span class="text-sm font-medium">当前页面</span>
      <span class="min-w-0 truncate text-xs text-muted-foreground" data-testid="popup-current-host">
        {{ host || '—' }}
      </span>
    </div>

    <!-- 子卡比外卡低一档圆角（rounded-md），嵌套层次才看得出来 -->
    <div class="flex flex-col gap-2 p-2">
      <!--
        记录开关（常显，**只有这一枚**）。开本身是个状态（开着是隐形的、最容易忘了关），
        藏起来用户就没地方确认此刻在不在记。它同时给这一页开两件事 —— 活动记录（存续行 + 事件
        + 脚本运行记账）与接口录制。记录是被动的：开着时这页的运行才带上标签页归属，「活动历史」
        里才找得到它；接口录制同理，录到的请求也挂在这同一页上。
        开关只落在**这一个标签页**上，同站点的其他页各开各的；关掉不清任何已录内容。
      -->
      <div class="rounded-md border border-border" data-testid="popup-current-tab-activity">
        <div class="flex h-8 items-center gap-2 px-2.5">
          <span class="shrink-0 text-xs text-muted-foreground">活动记录</span>
          <span
            class="flex min-w-0 flex-1 items-center gap-1.5"
            data-testid="popup-current-tab-activity-state"
          >
            <template v-if="tabRecording">
              <span class="size-1.5 shrink-0 rounded-full bg-primary" />
              <span class="min-w-0 truncate text-xs">正在记录</span>
            </template>
            <span v-else class="min-w-0 truncate text-xs text-muted-foreground">{{
              idleLabel
            }}</span>
          </span>
          <ui-switch
            :model-value="tabRecording"
            :disabled="toggleBusy || !canRecord"
            aria-label="活动记录"
            data-testid="popup-toggle-tab-activity"
            @update:model-value="toggleTabActivity"
          >
            <ui-switch-thumb />
          </ui-switch>
        </div>

        <!--
          刚扳开、页面还没重载：接口录制那半的钩子只在文档开头挂，这一句是「开关已开、
          首屏请求没录到」的唯一解释（活动记录那半不受影响，拨开即生效）。
        -->
        <p
          v-if="justEnabled"
          class="border-t border-border px-2.5 py-1.5 text-xs text-muted-foreground"
          data-testid="popup-recording-hint"
        >
          接口录制要刷新页面后才开始
        </p>

        <p
          v-if="toggleError"
          class="border-t border-border px-2.5 py-1.5 text-xs text-destructive"
          data-testid="popup-tab-activity-error"
        >
          {{ toggleError }}
        </p>
      </div>

      <div class="rounded-md border border-border">
        <div class="flex h-8 items-center gap-1.5 px-2.5">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            :aria-expanded="scriptsOpen"
            aria-label="展开或收起脚本列表"
            data-testid="popup-current-scripts-toggle"
            @click="scriptsOpen = !scriptsOpen"
          >
            <ui-chevron-down v-if="scriptsOpen" class="size-3 shrink-0 text-muted-foreground" />
            <ui-chevron-right v-else class="size-3 shrink-0 text-muted-foreground" />
            <span class="shrink-0 text-xs text-muted-foreground">脚本</span>
            <span
              class="min-w-0 truncate text-xs tabular-nums"
              data-testid="popup-current-scripts-summary"
            >
              {{ scriptSummary }}
            </span>
            <UiBadge
              v-if="errorCount"
              variant="destructive"
              data-testid="popup-current-scripts-error-count"
            >
              {{ errorCount }}
            </UiBadge>
          </button>
          <ui-tooltip-provider>
            <ui-tooltip>
              <ui-tooltip-trigger as-child>
                <ui-button
                  variant="ghost"
                  size="icon"
                  class="size-7 shrink-0"
                  aria-label="管理脚本"
                  data-testid="open-script-manager"
                  @click="openScriptManager"
                >
                  <!-- 与工作台左侧导航「脚本列表」同一枚图标：同一个去处，同一个标识 -->
                  <ui-list class="size-3.5" />
                </ui-button>
              </ui-tooltip-trigger>
              <ui-tooltip-content side="top">管理脚本</ui-tooltip-content>
            </ui-tooltip>
          </ui-tooltip-provider>
        </div>

        <div
          v-if="scriptsOpen && scripts.length"
          class="max-h-40 overflow-y-auto border-t border-border px-2.5 py-0.5"
        >
          <div
            v-for="script in scripts"
            :key="script.uuid"
            class="flex w-full items-center gap-2 border-b border-border py-1.5 last:border-b-0"
            :title="script.uuid"
            data-testid="popup-current-scripts-row"
          >
            <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ script.name }}</span>
            <span
              v-if="script.errorCount"
              class="shrink-0 text-[10px] font-semibold text-destructive"
            >
              ⚠ {{ script.errorCount }}
            </span>
            <span v-else class="shrink-0 text-[10px] text-muted-foreground">运行中</span>
          </div>
        </div>

        <!--
          内置件行（只读）：扩展自己注进这一页的能力管道 —— 不是用户脚本，没有源码 / 启停 /
          报错，故尾标说「内置」而不说「运行中」。
        -->
        <div v-if="scriptsOpen && builtins.length" class="border-t border-border px-2.5 py-0.5">
          <div
            v-for="builtin in builtins"
            :key="builtin.id"
            class="flex w-full items-center gap-2 py-1.5"
            data-testid="popup-current-builtin-row"
          >
            <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {{ builtin.name }}
            </span>
            <span class="shrink-0 text-[10px] text-muted-foreground">内置</span>
          </div>
        </div>
      </div>

      <popup-chat v-if="canChat && chatTabId != null" :tab-id="chatTabId" />
      <div v-else class="rounded-md border border-border">
        <div class="flex h-8 items-center gap-2 px-2.5">
          <span class="shrink-0 text-xs text-muted-foreground">对话</span>
          <span
            class="min-w-0 truncate text-xs text-muted-foreground"
            data-testid="popup-chat-disabled"
          >
            {{ chatDisabledHint }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
