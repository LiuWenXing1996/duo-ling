import {
  ALWAYS_GLOBALS,
  ALWAYS_NS,
  type GmInfo,
  type Json,
  gmAllGlobals,
  gmAllNs,
  resolveGrant,
} from '@duoling/shared'

export interface GmWrapperOptions {
  uuid: string
  name: string
  values: Record<string, Json>
  info: Omit<GmInfo, 'userAgent' | 'isIncognito'>
  pageSecret: string
  grant?: string[]
  resources?: Record<string, { text: string; url: string }>
  runAtBody?: boolean
  savedAt?: number
}

export function resolveGmExposure(grant: string[] | undefined): Record<string, boolean> {
  const flags: Record<string, boolean> = {}
  for (const name of [...gmAllGlobals(), ...gmAllNs()]) flags[name] = false
  for (const name of ALWAYS_GLOBALS) flags[name] = true
  for (const name of ALWAYS_NS) flags[name] = true
  for (const g of grant ?? []) {
    if (g === 'none') continue // 与「没写 @grant」同义：都不注入 GM 成员
    const m = resolveGrant(g)
    if (!m) continue
    for (const name of m.globals) flags[name] = true
    for (const name of m.ns) flags[name] = true
  }
  return flags
}

export function jsonLiteral(v: unknown): string {
  return JSON.stringify(v ?? null)
}
