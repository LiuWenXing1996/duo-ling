// 正在生成的会话（工作台「会话历史」用）：列表上给状态标、就地停止。
//
// 数据源是 SW 内存里那份「进行中」快照（`notify:list` 一并回），**不落库** —— 它没有稳定落点
// （SW 被回收后无法收尾），见 background 里 runningConversations 处的说明。
//
// 实时性靠两条广播：offscreen 的 `chat:running` / `chat:finished` 会广播到所有扩展上下文，
// 收到就重拉一次。这里**不做任何判断**（谁在跑归 SW 的内存），免得出现第二套口径。
import { onMounted, onUnmounted, ref, type Ref } from 'vue'
import type { NotificationSnapshot, RuntimeRequest, RuntimeResponse } from '@/shared/extension-ipc'

export function useChatRunning(): { runningIds: Ref<string[]>; refresh: () => Promise<void> } {
  const runningIds = ref<string[]>([])

  async function refresh(): Promise<void> {
    try {
      const res = (await chrome.runtime.sendMessage({
        kind: 'notify:list',
      } satisfies RuntimeRequest)) as RuntimeResponse<NotificationSnapshot> | undefined
      runningIds.value = res?.ok ? res.data.running.map((r) => r.conversationId) : []
    } catch {
      // SW 不在（扩展更新中 / 被禁用）：退化成「没有在跑的」，列表照常展示
      runningIds.value = []
    }
  }

  const onPush = (raw: unknown): void => {
    const kind = (raw as { kind?: string } | undefined)?.kind
    if (kind === 'chat:running' || kind === 'chat:finished') void refresh()
  }

  onMounted(() => {
    void refresh()
    chrome.runtime.onMessage.addListener(onPush)
  })
  onUnmounted(() => {
    chrome.runtime.onMessage.removeListener(onPush)
  })

  return { runningIds, refresh }
}
