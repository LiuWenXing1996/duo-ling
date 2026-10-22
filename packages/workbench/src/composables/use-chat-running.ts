// 正在生成的会话（工作台「会话历史」用）：列表上给状态标、就地停止。
//
// 数据源是 SW 内存里那份「进行中」登记表（`sw:runningChats` 只回会话 id），**不落库** —— 它没有
// 稳定落点（SW 被回收后无法收尾），见 background 里 runningConversations 处的说明。
//

import { onMounted, onUnmounted, ref, type Ref } from 'vue'
import { ipcRequest, ipcSubscribe } from '@duoling/shared'

export function useChatRunning(): { runningIds: Ref<string[]>; refresh: () => Promise<void> } {
  const runningIds = ref<string[]>([])

  async function refresh(): Promise<void> {
    try {
      runningIds.value = await ipcRequest<string[]>({ kind: 'sw:runningChats' })
    } catch {
      // SW 不在（扩展更新中 / 被禁用）：退化成「没有在跑的」，列表照常展示
      runningIds.value = []
    }
  }

  let offPush: (() => void) | undefined
  onMounted(() => {
    void refresh()

    offPush = ipcSubscribe('sw:', (msg) => {
      if (msg.kind === 'sw:runningChanged') void refresh()
    })
  })
  onUnmounted(() => {
    offPush?.()
  })

  return { runningIds, refresh }
}
