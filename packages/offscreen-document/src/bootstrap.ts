import { subscribeDataChange } from '@duoling/shared'
import { OffscreenService } from './offscreen-service'
import { startOffscreenLink } from './link-host'
import { refreshActiveProfile } from './chat/profile-cache'
import { reconcileFs } from './userstate/reconcile'

/** 宿主入口顶层调一次 */
export function startOffscreenHost(): void {
  const service = new OffscreenService()

  const link = startOffscreenLink(service)

  const pullProfile = (): void => {
    void refreshActiveProfile()
  }
  link.onOpen(pullProfile)
  if (link.isOpen) pullProfile()
  // 回拉触发走数据广播：写方可能在任何上下文（设置页直写 IDB），链路推送覆盖不全
  subscribeDataChange((push) => {
    if (push.domain === 'model') pullProfile()
  })
  void reconcileFs()
}
