import { liveQuery, readModelProfilesRaw } from '@duoling/shared'
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
  liveQuery(() => readModelProfilesRaw()).subscribe(() => pullProfile())
  void reconcileFs()
}
