<script setup lang="ts">
// 工作台「会话历史」标签页：回看历史会话（列表 + 消息回放），改名与删除也在这里。
// 布局（左栏 SessionHistoryPanel / 右栏「回放 / 原始数据」两视图切换）、删除前置门
// 与「告诉用户去关谁」的交互设计，见 ARCHITECTURE.md「对话链路」节。
//
// 数据：读与写都走 conversationClient（内部交 offscreen，唯一写方仍是 offscreen）；
// 删除会话时顺手清掉 conversation-tab-map 里的旧绑定。
import { computed, onMounted, ref } from 'vue'
import { ChatPanel } from '@duoling/ui'
import ConversationRawView from './ConversationRawView.vue'
import SessionHistoryPanel from './SessionHistoryPanel.vue'
import { useChatRunning } from '../composables/use-chat-running'
import { Button as UiButton } from '@duoling/ui/components/ui/button'
import {
  Dialog as UiDialog,
  DialogContent as UiDialogContent,
  DialogDescription as UiDialogDescription,
  DialogFooter as UiDialogFooter,
  DialogTitle as UiDialogTitle,
} from '@duoling/ui/components/ui/dialog'
import { useDbSignal } from '@duoling/ui/composables/use-data-sync'
import { getChatDexie } from '@duoling/shared'
import { toUiMessage } from '@duoling/shared'
import {
  findTabsUsingConversation,
  getActiveTabBindings,
  unbindAll,
  unbindConversation,
} from '@duoling/shared'
import type { TabConversationMap } from '@duoling/shared'
import { conversationClient } from '@duoling/ui/lib/conversation-client'
import { ipcRequest } from '@duoling/shared'
import type { Conversation, TokenUsage } from '@duoling/shared'
import type { UIMessage } from 'ai'

const conversations = ref<Conversation[]>([])
const selectedId = ref('')
/** 选中会话的消息（UIMessage，交给 ChatPanel 只读渲染） */
const messages = ref<UIMessage[]>([])
/** 与消息同源的 token 用量（按 UIMessage.id 索引），assistant 气泡下方展示 */
const usageByMessageId = ref<Record<string, TokenUsage>>({})

// —— 右栏视图切换：回放（逻辑视图）↔ 原始数据（落盘视图），同一会话两个面 ——
type SessionView = 'replay' | 'raw'
const VIEW_OPTIONS: { value: SessionView; label: string }[] = [
  { value: 'replay', label: '回放' },
  { value: 'raw', label: '原始数据' },
]
const view = ref<SessionView>('replay')

/** 选中会话的元数据（原始数据视图导出文件名 / payload 用）；列表里没有就是 null */
const selectedConversation = computed(
  () => conversations.value.find((c) => c.id === selectedId.value) ?? null,
)

/** 拉列表；选中的会话若已不存在（本页删的 / 别处删的）就清空右侧 */
async function loadList(): Promise<void> {
  try {
    conversations.value = await conversationClient.list()
  } catch {
    conversations.value = []
  }
  const stillThere = conversations.value.some((c) => c.id === selectedId.value)
  if (selectedId.value && !stillThere) {
    selectedId.value = ''
    messages.value = []
    usageByMessageId.value = {}
  }
  // 首次进来默认看最新一条（列表按 lastMessageAt 倒序），省一次点击
  if (!selectedId.value && conversations.value.length) {
    await select(conversations.value[0].id)
  }
}

/** 选中一条会话并回放它的消息；usage 只落在 assistant 分支，读之前先按 role 收窄 */
async function select(id: string): Promise<void> {
  selectedId.value = id
  try {
    const list = await conversationClient.messages(id)
    messages.value = list.map(toUiMessage)
    const usage: Record<string, TokenUsage> = {}
    for (const m of list) {
      if (m.role === 'assistant' && m.usage) usage[m.id] = m.usage
    }
    usageByMessageId.value = usage
  } catch {
    messages.value = []
    usageByMessageId.value = {}
  }
}

async function onRename(payload: { id: string; title: string }): Promise<void> {
  try {
    const updated = await conversationClient.rename(payload.id, payload.title)
    if (updated) {
      const idx = conversations.value.findIndex((c) => c.id === payload.id)
      if (idx !== -1) conversations.value[idx] = updated
    }
  } catch {
    // 失败不另报：列表由 conversation 域广播兜底回拉
  }
}

/** 「哪条会话 · 被哪个标签页占着」—— 弹框里逐条展示并配一个跳转按钮 */
interface BlockedTarget {
  tabId: number
  conversationTitle: string
  /** 站点名（取不到为空串，展示退化为「标签页」） */
  host: string
}

/**
 * 删除被挡下时的提示。
 *
 * 弹框形态由 **`kind`（哪种删除被挡）** 决定，**不由目标条数决定** ——
 * 按条数分会出岔：「删除全部」只碰到 1 个占用时，文案说「以下 1 条」而列表按
 * 「多于 1 条才显示」的规则不出现，就成了指向空气的「以下」，按钮措辞也跟着串成单条那套。
 */
const blocked = ref<{
  /** single = 单条删除被挡（文案带站点名 + 页脚一颗按钮）；all = 删除全部被挡（弹框里逐条列出） */
  kind: 'single' | 'all'
  text: string
  targets: BlockedTarget[]
} | null>(null)

/** 提示弹窗关闭（确认按钮 / 点遮罩 / Esc）→ 收起 */
function onBlockedChange(open: boolean): void {
  if (!open) blocked.value = null
}

/** 某标签页的站点名（取不到返回空串） */
async function tabHost(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs?.get(tabId)
    return tab?.url ? new URL(tab.url).host : ''
  } catch {
    return ''
  }
}

/** 把「tabId → conversationId」的映射展开成可展示的列表（会话标题从已有列表里取） */
async function buildTargets(bindings: TabConversationMap): Promise<BlockedTarget[]> {
  const targets: BlockedTarget[] = []
  for (const [tabIdRaw, conversationId] of Object.entries(bindings)) {
    const tabId = Number(tabIdRaw)
    targets.push({
      tabId,
      conversationTitle:
        conversations.value.find((c) => c.id === conversationId)?.title ?? '（会话已不存在）',
      host: await tabHost(tabId),
    })
  }
  return targets
}

/** 组装「删除全部被挡下」的弹框内容；没有占用则返回 null（= 可以删） */
async function buildAllBlocked(): Promise<{
  kind: 'all'
  text: string
  targets: BlockedTarget[]
} | null> {
  const targets = await buildTargets(await getActiveTabBindings())
  if (!targets.length) return null
  return {
    kind: 'all',
    // 「以下 N 条」这句与列表是同一条信息的两个面 —— 只有一条时也照列，别省列表
    text: `以下 ${targets.length} 条会话正在被标签页使用，无法全部删除。关闭对应标签页后再试。`,
    targets,
  }
}

/**
 * 跳到指定标签页。
 *
 * 跨窗口时**必须先聚焦窗口再激活标签页** —— 只 `tabs.update({active})` 不会把那个窗口
 * 翻到前台，用户还是看不到是哪个。
 *
 * 跳完**不收起弹框**：多个目标时用户要连着关好几个，收起就得重新点一次删除才能看到剩下的。
 * 只有目标已经不在（用户刚关掉它，或点了过期的条目）才动弹框 —— 多条时重算列表、单条时直接收起。
 */
async function focusTab(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true })
    await chrome.tabs.update(tabId, { active: true })
  } catch {
    // 目标已不在：删除全部的场景重算列表（用户可能刚关掉其中一条），单条的直接收起
    blocked.value = blocked.value?.kind === 'all' ? await buildAllBlocked() : null
  }
}

/**
 * 删除（单条 / 全部）。
 *
 * **前置门：会话正被开着的标签页使用就不让删** —— 会话是那个标签页的现场（消息流水、
 * 正在跑的任务都挂在它上面），删掉等于把用户正在看的东西抽走。判据是「映射里有 + 那个
 * 标签页还开着」（见 conversation-tab-map 的 getActiveTabBindings），所以关掉标签页之后
 * 就能删了；用户想接着聊，重新打开一个标签页即可。
 *
 * 拦截放在这里而不是 SessionHistoryPanel：面板只管列表与交互，业务规则归宿主。
 */

async function onDelete(payload: {
  type: 'session' | 'all'
  id?: string
  title?: string
}): Promise<void> {
  if (payload.type === 'all') {
    // 可能有若干条摊在不同标签页上：逐条列出来，每条配一个跳转按钮
    const next = await buildAllBlocked()
    if (next) {
      blocked.value = next
      return
    }
  } else {
    if (!payload.id) return
    const using = await findTabsUsingConversation(payload.id)
    if (using.length) {
      // 一条会话正常只归属一个标签页（tab → 会话是 1:1），取第一个即可
      const tabId = using[0]
      const host = await tabHost(tabId)
      blocked.value = {
        kind: 'single',
        text: host
          ? `该会话正在被「${host}」标签页使用，无法删除。关闭那个标签页后即可删除。`
          : '该会话正在被标签页使用，无法删除。关闭那个标签页后即可删除。',
        targets: [{ tabId, conversationTitle: payload.title ?? '该会话', host }],
      }
      return
    }
  }

  try {
    if (payload.type === 'all') {
      await conversationClient.deleteAll()
      await unbindAll().catch(() => {})
      conversations.value = []
      selectedId.value = ''
      messages.value = []
      usageByMessageId.value = {}
      return
    }
    if (!payload.id) return
    await conversationClient.delete(payload.id)
    // 清掉指向它的归属绑定：否则对应标签页的映射会一直指着一条已不存在的会话
    await unbindConversation(payload.id).catch(() => {})
  } catch {
    // 同上：交给广播回拉兜底
  }
}

// 别处（对话界面所在标签页之外）增删改会话 → 回拉列表。
// 本页自己的删除已在 onDelete 里就地更新，重复回拉无副作用。
useDbSignal(
  () => getChatDexie().conversations.toArray(),
  () => void loadList(),
)

/** 正在生成的会话：列表上给状态标与就地停止入口（数据源见 useChatRunning） */
const { runningIds } = useChatRunning()

/**
 * 就地停止某条会话的生成（状态归 SW，`chat:finished` 广播回来触发重拉，这里不做第二套口径）。
 * 为什么必须在这里也能停见 docs/adr/0036-workbench-stop-generation-entry.md。
 */
async function onStop(id: string): Promise<void> {
  try {
    await ipcRequest({ kind: 'chat:abort', conversationId: id })
  } catch {
    // 发不出去（SW 不在）：状态由列表下次刷新纠正，这里不额外报错
  }
}

onMounted(() => void loadList())
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0">
    <!-- 左栏固定宽度：SessionHistoryPanel 自己是 flex-1，宽度得由外层定 -->
    <div class="flex min-h-0 w-72 shrink-0">
      <session-history-panel
        class="min-h-0 flex-1"
        variant="page"
        :conversations="conversations"
        :active-conversation-id="selectedId"
        :running-ids="runningIds"
        @activate="select"
        @delete="onDelete"
        @rename="onRename"
        @stop="onStop"
      />
    </div>

    <!-- 右栏：选中会话的两个视图。切到原始数据视图不换选中态 —— 对照排查时来回切，列表与选中都要留在原地 -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        v-if="selectedId"
        class="flex shrink-0 items-center justify-end border-b border-border px-3 py-1.5"
      >
        <div class="flex items-center rounded-md bg-muted p-0.5" data-testid="session-view-toggle">
          <button
            v-for="v in VIEW_OPTIONS"
            :key="v.value"
            type="button"
            class="rounded px-2 py-0.5 text-xs transition-colors"
            :class="
              view === v.value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            "
            :data-testid="`session-view-${v.value}`"
            @click="view = v.value"
          >
            {{ v.label }}
          </button>
        </div>
      </div>

      <!-- 回放：只读，无输入区 -->
      <chat-panel
        v-if="selectedId && view === 'replay'"
        class="min-h-0 flex-1"
        readonly
        :messages="messages"
        :usage-by-message-id="usageByMessageId"
        :streaming="false"
        @send="() => {}"
        @stop="() => {}"
        @open-settings="() => {}"
        @open-guide="() => {}"
      />
      <!-- 原始数据：落盘 Message 原始记录（只读调试视图） -->
      <conversation-raw-view
        v-else-if="selectedId"
        class="min-h-0 flex-1"
        :conversation="selectedConversation"
      />

      <div v-if="!selectedId" class="flex min-h-0 flex-1 items-center justify-center">
        <p class="text-sm text-muted-foreground">从左侧选一条会话查看</p>
      </div>
    </div>

    <!-- 删除被挡下的提示：会话正被标签页使用。用提示而非确认框 ——
         这是「不能做」，不是「要不要做」，给个确认按钮没有意义。 -->
    <ui-dialog :open="!!blocked" @update:open="onBlockedChange">
      <ui-dialog-content class="max-w-md">
        <ui-dialog-title class="text-base font-semibold">无法删除</ui-dialog-title>
        <ui-dialog-description class="text-sm text-muted-foreground">
          {{ blocked?.text }}
        </ui-dialog-description>

        <!-- 「删除全部」被挡下：逐条给出「哪条会话 · 在哪个站点 · 跳过去」。
             判据是 kind（哪种删除被挡）而非条数 —— 只有一条时「以下 N 条」这句也必须配着列表看。
             单条删除的文案里已经写明是哪个站点，不必再铺一层列表。 -->
        <ul
          v-if="blocked?.kind === 'all'"
          class="mt-3 flex max-h-64 flex-col gap-1.5 overflow-y-auto scroll-gap"
        >
          <li
            v-for="target in blocked!.targets"
            :key="target.tabId"
            class="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5"
          >
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm text-foreground">
                {{ target.conversationTitle }}
              </span>
              <span class="block truncate text-xs text-muted-foreground">
                {{ target.host || '标签页' }}
              </span>
            </span>
            <ui-button
              variant="outline"
              size="xs"
              class="shrink-0"
              @click="void focusTab(target.tabId)"
            >
              去标签页
            </ui-button>
          </li>
        </ul>

        <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
          <!-- 单条删除：信息已在文案里，页脚一颗按钮即可（跨窗口会把窗口一起翻上来） -->
          <ui-button
            v-if="blocked?.kind === 'single'"
            variant="outline"
            size="sm"
            @click="void focusTab(blocked!.targets[0].tabId)"
          >
            去那个标签页
          </ui-button>
          <ui-button size="sm" @click="blocked = null">知道了</ui-button>
        </ui-dialog-footer>
      </ui-dialog-content>
    </ui-dialog>
  </div>
</template>
