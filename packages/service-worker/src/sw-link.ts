import {
  acceptLink,
  createServiceClient,
  LinkError,
  withTransportRetry,
  type IOffscreenService,
  type Link,
  type LinkHandlers,
} from '@duoling/shared'
import { ensureOffscreen } from './offscreen'

let current: Link | null = null

export function startServiceWorkerLink(handlers: LinkHandlers): Link {
  if (current) return current
  current = acceptLink({ handlers })
  return current
}

export function serviceWorkerLink(): Link | null {
  return current
}

export function stopServiceWorkerLink(): void {
  current?.close()
  current = null
}

function requireLink(): Link {
  if (!current) throw new LinkError('TRANSPORT', '链路未启动')
  return current
}

export function whenLinkReady(timeoutMs?: number): Promise<void> {
  return requireLink().whenReady(timeoutMs)
}

export const offscreenService: IOffscreenService = withTransportRetry(
  createServiceClient<IOffscreenService>({
    request: (type, payload, opts) => requireLink().request(type, payload, opts),
  }),
  () => ensureLinkReady(),
)

export async function ensureLinkReady(timeoutMs = 5000): Promise<boolean> {
  await ensureOffscreen().catch(() => {})
  try {
    await requireLink().whenReady(timeoutMs)
    return true
  } catch {
    return false
  }
}
