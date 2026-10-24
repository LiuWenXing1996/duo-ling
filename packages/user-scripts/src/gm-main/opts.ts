import type { GmInfo } from '@duoling/shared'

export interface GmMainOpts {
  info: Omit<GmInfo, 'userAgent' | 'isIncognito'> &
    Partial<Pick<GmInfo, 'userAgent' | 'isIncognito'>>
  has: Record<string, boolean>
  values: Record<string, any>
  resources: Record<string, { text: string; url: string }>
  name: string
  savedAt: number | null
  srcMark: string
}
