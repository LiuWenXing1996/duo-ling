// 正在生成的会话（工作台「会话历史」用）：列表上给状态标、就地停止。
//
// 数据源是 SW 内存里那份「进行中」登记表（`sw:runningChats` 只回会话 id），**不落库** —— 它没有
// 稳定落点（SW 被回收后无法收尾），见 background 里 runningConversations 处的说明。
//
// 实时性靠两条广播：offscreen 的 `chat:running` / `chat:finished` 会广播到所有扩展上下文，
// 收到就重拉一次。这里**不做任何判断**（谁在跑归 SW 的内存），免得出现第二套口径。
import { onMounted, onUnmounted, ref, type Ref } from 'vue'
import { ipcRequest, ipcSubscribe } from '@/shared/ipc-bus'

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
    // 两条推送合一个订阅面：收到任一条就重拉（判据在回调里，与总线无关）
    offPush = ipcSubscribe('chat:', (msg) => {
      if (msg.kind === 'chat:running' || msg.kind === 'chat:finished') void refresh()
    })
  })
  onUnmounted(() => {
    offPush?.()
  })

  return { runningIds, refresh }
}
