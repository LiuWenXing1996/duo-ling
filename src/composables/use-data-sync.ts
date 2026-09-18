// 数据变更订阅：让面板在「别处改了数据」时自动回拉。
//
// 用法：
//   useDataSync('script', () => refresh())
//
// 为什么需要它：IndexedDB 没有变更通知，而脚本项目 / 会话都落在 IDB 里。
// 写侧（offscreen / SW）落盘后广播一条「哪个域的哪条变了」（见 lib/data-broadcast.ts），
// 这里负责接住并触发重拉——数据仍由面板自己去权威存储取，广播不带任何数据。
//
// 并发保护：重拉是异步的，若上一次还没回来又来一条通知，直接并发会把「后发先到」的
// 旧数据写在后面。故这里串行执行，并把期间的重复通知合并成**最后一次**补跑一次。

import { onScopeDispose } from 'vue'
import { subscribeDataChange } from '@/lib/data-broadcast'
import type { DataChangedPush, DataDomain } from '@/shared/extension-ipc'

/**
 * 订阅一个或多个数据域的变更。
 *
 * 必须在组件（或 composable）的 setup 作用域内调用：卸载时靠 onScopeDispose 自动退订。
 * 注意工作台标签页是 `unmount-on-hide=false`，切走的标签页**不会卸载**——
 * 于是后台面板照样能收到通知并更新，切回来时看到的已是新数据，这正是想要的。
 *
 * @param reload 重拉函数；收到被合并掉的多次通知时，只会以**最后一条**被调用一次
 */
export function useDataSync(
  domains: DataDomain | DataDomain[],
  reload: (push: DataChangedPush) => void | Promise<void>,
): void {
  const wanted = new Set<DataDomain>(Array.isArray(domains) ? domains : [domains])

  let running = false
  let queued: DataChangedPush | null = null

  const run = async (push: DataChangedPush): Promise<void> => {
    if (running) {
      queued = push // 正在拉：记下最新的，结束后补跑一次（中间那些已被它代表）
      return
    }
    running = true
    try {
      await reload(push)
    } catch {
      // 重拉失败不该让订阅链断掉：下一次变更仍要能触发
    } finally {
      running = false
    }
    if (queued) {
      const next = queued
      queued = null
      void run(next)
    }
  }

  const unsubscribe = subscribeDataChange((push) => {
    if (wanted.has(push.domain)) void run(push)
  })
  onScopeDispose(unsubscribe)
}
