<script setup lang="ts">
// 「当前页面」区块：本标签页的按页开关（**只有一枚**，常显）—— 活动记录，它同时管着接口录制；
// 另有本页在跑哪些脚本、这条页面的对话浮层（快捷入口与「是否正在回话」）。
//
// 判据都不在这里现算：PopupPanel 挂载时经一条 page:overview 命令取回，再传进来 —— popup 是纯
// 展示面板（不装 window.api、不直连会话库），聚合口径统一在 SW 侧一处（见 shared/extension-ipc
// 的 PageOverviewTab）。popup 只活几秒，故取一次快照即可，不维持推送通道。
//
// 浮层入口：对话框平时不在页面里（浮层宿主件不建任何 DOM，见 packages/builtin-scripts/src/float-host/），
// 这颗按钮是它的常规打开方式（另一条是页面右键菜单）。**禁用只留给拿不到网址的页面**（浏览器内部页 /
// 扩展页）：那里连站点名都读不出来，「刷新页面后再试」会变成误导。普通网页一律让点 —— 能不能挂得上
// 由点了之后的回执说话（见 openFloatPanel），不预先探活（理由见 lib/web-hostname.ts）。
// 不可用的原因就地说在对话行中间（与「活动记录 / 脚本」两行对不可用状态的说法同款），不单独占一行。
//
// 脚本卡头部与列表常显（不做折叠）：这一卡本就是「这页在跑什么」的全部答案，藏起来还得再点一下；
// 脚本多时列表自己滚，卡高不跟着涨。没脚本时头部给空态说法，按「能不能注入」分 —— 藏起整卡会让
// 用户以为没有这个功能。
//
// 布局：卡片套卡片 —— 外卡是「当前页面」（头部 + 站点名），两个开关 / 脚本 / 对话各是里面的一张子卡。
import { computed, ref } from 'vue'
import { List as UiList, MessageSquare as UiMessageSquare } from '@lucide/vue'
import { Badge as UiBadge } from '@/components/ui/badge'
import { Button as UiButton } from '@/components/ui/button'
import { Switch as UiSwitch, SwitchThumb as UiSwitchThumb } from '@/components/ui/switch'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger,
} from '@/components/ui/tooltip'
import { EXTENSION_NAME } from '@/lib/extension-identity'
import { floatOpenRequest, type PageOverviewTab, type RuntimeResponse } from '@/shared/extension-ipc'
import { errorText } from '@/lib/format'

const props = defineProps<{
  /** 当前页的站点名（拿不到 url 的内部页上是空串，见 lib/web-hostname.ts） */
  host: string
  /** 当前标签页的概览；null = 这一页不在概览里（内部页 / 扩展页 / 读不到标签页） */
  tab: PageOverviewTab | null
}>()

/** 开关切换成功后上抛给父组件（popup 不维持推送通道，由父组件就地更新这一行的状态位） */
const emit = defineEmits<{
  tabRecordingChanged: [tabId: number, recording: boolean]
}>()

/** 「打开会话」没打通时的说明（成功就直接关窗了） */
const openError = ref('')

/**
 * 这一页是不是普通网页（http / https）—— 判据就是「有没有站点名」：内部页 / 扩展页上扩展读不到
 * url，那份空串既是站点名缺失，也是「这一页跑不了脚本、挂不了浮层」的同一条事实（见
 * lib/web-hostname.ts）。故不再单独传一个「能不能挂浮层」的布尔进来 —— 同一个事实两处进，
 * 迟早对不上。
 */
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
 * 对话行只报一件事：**此刻 AI 在不在回话**。
 *
 * 不报会话标题、也不报「有会话 / 尚无会话」—— 那是状态栏文案，浮层与工作台里都看得到，
 * 摆在只活几秒的 popup 里只是噪音；这一行要的就是那个「在回话」的信号（配一颗圆点）。
 */
const conversationLabel = computed(() => (props.tab?.generating ? 'AI 正在回话' : ''))

/** 浮层入口是纯图标按钮，悬停提示兼作它的名字（按钮本身没有文字，提示常弹） */
const openFloatHint = '打开会话'
/**
 * 「打开会话」禁用时的原因，就地说在对话行中间 —— 与「活动记录 / 脚本」两行对不可用状态的
 * 说法同款（原因摆在它归属的那一行），tooltip 只管按钮名字，不背原因。它只会在拿不到网址的
 * 页面（浏览器内部页 / 扩展页）上出现，普通网页一律让点。
 */
const openFloatDisabledHint = '当前页面不能显示对话浮层'

/**
 * 把当前页面的对话浮层调出来。
 *
 * **这就是判成败的全部依据**：不预先探活（探活答的是「此刻」，答「不在」不等于真挂不上，见
 * lib/web-hostname.ts），发了 `float:open` 收得到就开、收不到就地给提示。
 *
 * 收不到（页面在扩展更新前就打开、或在扩展管理页里单独禁掉了本站点的访问权）只能让用户刷新；
 * 这两种情况 popup 判不出来，所以文案不指向具体原因。失败时留在面板里把话说出来 —— 关了就没
 * 地方说了。
 */
async function openFloatPanel(): Promise<void> {
  openError.value = ''
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  // 读不到标签页时静默退场：这是 popup 与页面失联的异常态，给技术性报错只是噪音
  if (tab?.id == null) return
  try {
    await chrome.tabs.sendMessage(tab.id, floatOpenRequest(tab.id))
  } catch {
    openError.value = `页面还没接上${EXTENSION_NAME}，刷新页面后再试。`
    return
  }
  window.close()
}

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
    const res = (await chrome.runtime.sendMessage(
      next
        ? { kind: 'userscript:tabActivityEnable', tabId }
        : { kind: 'userscript:tabActivityDisable', tabId },
    )) as RuntimeResponse<unknown> | undefined
    if (!res?.ok) throw new Error(res?.error || '未知错误')
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
            <span v-else class="min-w-0 truncate text-xs text-muted-foreground">{{ idleLabel }}</span>
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

      <!-- 脚本卡：头部给计数与错误徽标，列表常显（脚本多时自己滚，见 max-h） -->
      <div class="rounded-md border border-border">
        <div class="flex h-8 items-center gap-2 px-2.5">
          <span class="shrink-0 text-xs text-muted-foreground">脚本</span>
          <span class="min-w-0 truncate text-xs tabular-nums" data-testid="popup-current-scripts-summary">
            {{ scriptSummary }}
          </span>
          <UiBadge
            v-if="errorCount"
            variant="destructive"
            data-testid="popup-current-scripts-error-count"
          >
            {{ errorCount }}
          </UiBadge>
          <ui-tooltip-provider>
            <ui-tooltip>
              <ui-tooltip-trigger as-child>
                <ui-button
                  variant="ghost"
                  size="icon"
                  class="ml-auto size-7 shrink-0"
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
          v-if="scripts.length"
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
        <div v-if="builtins.length" class="border-t border-border px-2.5 py-0.5">
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

      <!--
        对话卡：状态 + 浮层入口（纯图标按钮）。禁用原因就地说在行中间（见 openFloatDisabledHint），
        不占独立一行。按钮外套 span 是必需的 —— Tooltip 的触发器只能落在 span 上，禁用按钮不收
        指针事件，直接套在按钮上会让整枚提示哑掉（reka-ui 的 as-child 只认最外层那个元素）。
      -->
      <div class="rounded-md border border-border">
        <div class="flex h-8 items-center gap-2 px-2.5">
          <span class="shrink-0 text-xs text-muted-foreground">对话</span>
          <span class="flex min-w-0 flex-1 items-center gap-1.5" data-testid="popup-current-conversation">
            <template v-if="conversationLabel">
              <span class="size-1.5 shrink-0 rounded-full bg-primary" />
              <span class="min-w-0 truncate text-xs">{{ conversationLabel }}</span>
            </template>
            <span
              v-else-if="!isWebPage"
              class="min-w-0 truncate text-xs text-muted-foreground"
              data-testid="popup-current-float-disabled"
            >
              {{ openFloatDisabledHint }}
            </span>
          </span>
          <ui-tooltip-provider>
            <ui-tooltip>
              <ui-tooltip-trigger as-child>
                <span class="inline-flex shrink-0">
                  <ui-button
                    variant="ghost"
                    size="icon"
                    class="size-7"
                    :disabled="!isWebPage"
                    aria-label="打开会话"
                    data-testid="open-float-panel"
                    @click="openFloatPanel"
                  >
                    <ui-message-square class="size-3.5" />
                  </ui-button>
                </span>
              </ui-tooltip-trigger>
              <ui-tooltip-content side="top">{{ openFloatHint }}</ui-tooltip-content>
            </ui-tooltip>
          </ui-tooltip-provider>
        </div>

        <p
          v-if="openError"
          class="border-t border-border px-2.5 py-1.5 text-xs text-destructive"
          data-testid="open-float-error"
        >
          {{ openError }}
        </p>
      </div>
    </div>
  </div>
</template>
