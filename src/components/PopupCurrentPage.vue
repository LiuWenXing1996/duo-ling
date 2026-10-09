<script setup lang="ts">
// 「当前页面」区块：本页在跑哪些脚本 + 这条页面的对话浮层（快捷入口与「是否正在回话」）。
//
// 判据都不在这里现算：PopupPanel 挂载时经一条 page:overview 命令取回，再传进来 —— popup 是纯
// 展示面板（不装 window.api、不直连会话库），聚合口径统一在 SW 侧一处（见 shared/extension-ipc
// 的 PageOverviewTab）。popup 只活几秒，故取一次快照即可，不维持推送通道。
//
// 浮层入口：对话框平时不在页面里（content script 默认不往页面放任何 DOM，见 content.ts），
// 这颗按钮是它的常规打开方式（另一条是页面右键菜单）。注入不了内容脚本的页面（浏览器内部页 /
// 扩展页 / 应用商店 / 站点权限设成「点击时」的站点…）上打不开不是装坏了 —— 原因挂在按钮的
// tooltip 上（不可用时按钮禁灰、提示改显原因），不单独占一行。
//
// 脚本卡头部与列表常显（不做折叠）：这一卡本就是「这页在跑什么」的全部答案，藏起来还得再点一下；
// 脚本多时列表自己滚，卡高不跟着涨。没脚本时头部给空态说法，按「能不能注入」分 —— 藏起整卡会让
// 用户以为没有这个功能。
//
// 布局：卡片套卡片 —— 外卡是「当前页面」（头部 + 站点名），脚本 / 对话各是里面的一张子卡。
import { computed, ref } from 'vue'
import { MessageSquare as UiMessageSquare } from '@lucide/vue'
import { Badge as UiBadge } from '@/components/ui/badge'
import { Button as UiButton } from '@/components/ui/button'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger,
} from '@/components/ui/tooltip'
import { EXTENSION_NAME } from '@/lib/extension-identity'
import { FLOAT_OPEN_REQUEST, type PageOverviewTab } from '@/shared/extension-ipc'

const props = defineProps<{
  /** 当前页的站点名（拿不到 url 的内部页上是空串） */
  host: string
  /** 当前标签页能不能注入内容脚本（判据见 lib/float-panel-host.ts） */
  injectable: boolean
  /** 当前标签页的概览；null = 这一页不在概览里（内部页 / 扩展页 / 读不到标签页） */
  tab: PageOverviewTab | null
}>()

/** 「打开会话」没打通时的说明（成功就直接关窗了） */
const openError = ref('')

const scripts = computed(() => props.tab?.scripts ?? [])
const errorCount = computed(() => scripts.value.reduce((n, s) => n + s.errorCount, 0))

/**
 * 脚本卡头部行的计数文案。
 *
 * 「不能运行」只在**确无运行记录**时才说：探活答的是「此刻」，可能滞后于登记表（页面刚导航、
 * 内容脚本还没跑起来时探活说不在，而记录还在）—— 那种时候照常给数量，否则会出现「说不能运行、
 * 却又能列出 2 条」的自相矛盾。
 */
const scriptSummary = computed(() => {
  if (scripts.value.length) return `${scripts.value.length} 个在运行`
  return props.injectable ? '本页没有运行中的脚本' : '当前页面不能运行脚本'
})

/**
 * 对话行只报一件事：**此刻 AI 在不在回话**。
 *
 * 不报会话标题、也不报「有会话 / 尚无会话」—— 那是状态栏文案，浮层与工作台里都看得到，
 * 摆在只活几秒的 popup 里只是噪音；这一行要的就是那个「在回话」的信号（配一颗圆点）。
 */
const conversationLabel = computed(() => (props.tab?.generating ? 'AI 正在回话' : ''))

/** 「打开会话」禁用时的悬停提示：一句话点明事实即可（可用时不弹，按钮上的文字已经说明它干什么） */
const openFloatHint = '当前页面不能显示对话浮层'

/**
 * 点脚本行 → 深链到工作台该脚本的错误日志，随后关掉面板。
 * 关闭延后一帧：上行是异步投递，同一 tick 里关掉文档会让这条消息悬空。
 */
function openScript(uuid: string): void {
  void chrome.runtime.sendMessage({ kind: 'page:openErrors', uuid }).catch(() => {})
  setTimeout(() => window.close(), 0)
}

/**
 * 把当前页面的对话浮层调出来。
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
    await chrome.tabs.sendMessage(tab.id, FLOAT_OPEN_REQUEST)
  } catch {
    openError.value = `页面还没接上${EXTENSION_NAME}，刷新页面后再试。`
    return
  }
  window.close()
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
      <!-- 脚本卡：头部给计数与错误徽标，列表常显（脚本多时自己滚，见 max-h） -->
      <div class="rounded-md border border-border">
        <div class="flex items-center gap-2 px-2.5 py-1.5">
          <span class="shrink-0 text-xs text-muted-foreground">脚本</span>
          <span class="min-w-0 truncate text-xs tabular-nums" data-testid="popup-current-scripts-summary">
            {{ scriptSummary }}
          </span>
          <UiBadge
            v-if="errorCount"
            variant="destructive"
            class="ml-auto"
            data-testid="popup-current-scripts-error-count"
          >
            {{ errorCount }}
          </UiBadge>
        </div>

        <div
          v-if="scripts.length"
          class="max-h-40 overflow-y-auto border-t border-border px-2.5 py-0.5"
        >
          <button
            v-for="script in scripts"
            :key="script.uuid"
            class="flex w-full items-center gap-2 border-b border-border py-1.5 text-left last:border-b-0"
            :title="script.uuid"
            data-testid="popup-current-scripts-row"
            @click="openScript(script.uuid)"
          >
            <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ script.name }}</span>
            <span
              v-if="script.errorCount"
              class="shrink-0 text-[10px] font-semibold text-destructive"
            >
              ⚠ {{ script.errorCount }}
            </span>
            <span v-else class="shrink-0 text-[10px] text-muted-foreground">运行中</span>
          </button>
        </div>
      </div>

      <!--
        对话卡：状态 + 浮层入口。按钮外套 span 是必需的 —— Tooltip 的触发器只能落在 span 上，
        禁用按钮不收指针事件，直接套在按钮上会让整枚提示哑掉（reka-ui 的 as-child 只认最外层那个元素）。
      -->
      <div class="rounded-md border border-border">
        <div class="flex items-center gap-2 px-2.5 py-1.5">
          <span class="shrink-0 text-xs text-muted-foreground">对话</span>
          <span class="flex min-w-0 flex-1 items-center gap-1.5" data-testid="popup-current-conversation">
            <template v-if="conversationLabel">
              <span class="size-1.5 shrink-0 rounded-full bg-primary" />
              <span class="min-w-0 truncate text-xs">{{ conversationLabel }}</span>
            </template>
          </span>
          <ui-tooltip-provider>
            <ui-tooltip>
              <ui-tooltip-trigger as-child>
                <span class="inline-flex shrink-0">
                  <ui-button
                    variant="outline"
                    size="sm"
                    class="h-7 px-2 text-xs"
                    :disabled="!injectable"
                    data-testid="open-float-panel"
                    @click="openFloatPanel"
                  >
                    <ui-message-square class="size-3.5" />
                    打开会话
                  </ui-button>
                </span>
              </ui-tooltip-trigger>
              <ui-tooltip-content v-if="!injectable" side="top" class="max-w-64">
                {{ openFloatHint }}
              </ui-tooltip-content>
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
