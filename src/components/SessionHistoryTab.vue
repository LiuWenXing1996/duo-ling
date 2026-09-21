<script setup lang="ts">
// 工作台「会话历史」标签页：回看历史会话（列表 + 消息回放），改名与删除也在这里。
//
// 为什么会话历史需要一个独立去处：对话界面（网页浮层）的会话**归属由标签页决定**
// —— 一个 tab 一条会话、切 tab 即切会话，所以那里既没有会话列表也没有「新建会话」。
// 历史会话因此收进工作台这个重界面：它是「查看与管理」的落点，不是对话的落点。
//
// 布局：左栏复用 SessionHistoryPanel（搜索 / 日期分组 / 改名 / 删除），右栏用 ChatPanel 的
// **只读模式**（readonly）回放选中会话的消息 —— 与对话界面同一套渲染，不另写回放视图。
//
// 数据：列表与消息都直连 IndexedDB（conversation-store 读侧经 window.api 转发），写走
// window.api.conversation.*（唯一写方仍是 offscreen）。删除会话时顺手清掉标签页归属映射
// （conversation-tab-map），免得留下指向已删会话的旧绑定。
//
// **删除有前置门**：会话正被开着的标签页使用就不让删 —— 它是那个标签页的现场。判据是
// 「映射里有 + 那个标签页还开着」（不是「映射里有」：SW 没来得及清理的残留项会把已关闭的
// 标签页算成在用，用户就删不掉又找不到是哪个标签页）。关掉标签页后即可删除；想接着聊，
// 重新打开一个标签页就是一条新会话。
//
// 被挡下时不只是拒绝，还要**告诉用户去关谁**：单条删除给文案 + 一颗「去那个标签页」按钮；
// 「删除全部」可能有若干条摊在不同标签页上，就在弹框里逐条列出「哪条会话 · 哪个站点」，
// 每条各配一个跳转按钮。跳转一律「先聚焦窗口再激活标签页」，且**不收起弹框** ——
// 用户往往要连着关好几个，收起就得重新点一次删除才能看到剩下的。
import { onMounted, ref } from 'vue'
import ChatPanel from '@/components/ChatPanel.vue'
import SessionHistoryPanel from '@/components/SessionHistoryPanel.vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  Dialog as UiDialog,
  DialogContent as UiDialogContent,
  DialogDescription as UiDialogDescription,
  DialogFooter as UiDialogFooter,
  DialogTitle as UiDialogTitle
} from '@/components/ui/dialog'
import { useDataSync } from '@/composables/use-data-sync'
import { toUiMessage } from '@/lib/conversation-message'
import {
  findTabsUsingConversation,
  getActiveTabBindings,
  unbindAll,
  unbindConversation
} from '@/lib/conversation-tab-map'
import type { TabConversationMap } from '@/lib/conversation-tab-map'
import type { Conversation, TokenUsage } from '@/shared/types'
import type { UIMessage } from 'ai'

const conversations = ref<Conversation[]>([])
const selectedId = ref('')
/** 选中会话的消息（UIMessage，交给 ChatPanel 只读渲染） */
const messages = ref<UIMessage[]>([])
/** 与消息同源的 token 用量（按 UIMessage.id 索引），assistant 气泡下方展示 */
const usageByMessageId = ref<Record<string, TokenUsage>>({})

/** 拉列表；选中的会话若已不存在（本页删的 / 别处删的）就清空右侧 */
async function loadList(): Promise<void> {
  try {
    conversations.value = await window.api.conversation.list()
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
    const list = await window.api.conversation.messages(id)
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
    const updated = await window.api.conversation.rename(payload.id, payload.title)
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
      await window.api.conversation.deleteAll()
      await unbindAll().catch(() => {})
      conversations.value = []
      selectedId.value = ''
      messages.value = []
      usageByMessageId.value = {}
      return
    }
    if (!payload.id) return
    await window.api.conversation.delete(payload.id)
    // 清掉指向它的归属绑定：否则对应标签页的映射会一直指着一条已不存在的会话
    await unbindConversation(payload.id).catch(() => {})
  } catch {
    // 同上：交给广播回拉兜底
  }
}

// 别处（对话界面所在标签页之外）增删改会话 → 回拉列表。
// 本页自己的删除已在 onDelete 里就地更新，重复回拉无副作用。
useDataSync('conversation', () => void loadList())

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
        @activate="select"
        @delete="onDelete"
        @rename="onRename"
      />
    </div>

    <!-- 右栏：选中会话的消息回放（只读，无输入区） -->
    <div class="min-h-0 min-w-0 flex-1">
      <chat-panel
        v-if="selectedId"
        class="h-full"
        readonly
        :messages="messages"
        :usage-by-message-id="usageByMessageId"
        :streaming="false"
        @send="() => {}"
        @stop="() => {}"
        @open-settings="() => {}"
        @open-guide="() => {}"
      />
      <div v-else class="flex h-full items-center justify-center">
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
