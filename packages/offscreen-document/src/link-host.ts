import { connectLink, serveService, type IOffscreenService, type Link } from '@duoling/shared'

let current: Link | null = null

export function startOffscreenLink(service: IOffscreenService): Link {
  if (current) return current
  const link = connectLink()
  serveService(link, service)
  current = link
  return link
}

export function offscreenLink(): Link | null {
  return current
}

export function stopOffscreenLink(): void {
  current?.close()
  current = null
}
