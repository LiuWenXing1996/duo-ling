// `@resource` 命名资源的内容缓存 + 抓取（SW 独占读写；与 @require 缓存分库）。
// 分库理由、同步就绪与失败策略见 docs/adr/0006-resource-cache-separate-db.md。

import {
  bytesToBase64,
  errorText,
  getResourceCacheDb,
  RESOURCE_CACHE_STORE as STORE,
} from '@duoling/shared'
import { cacheClear, cacheGetAll, cachePutAll, fetchWithTimeout } from './cache-common'

/** 一条资源缓存记录：文本与 data URI 都存下来，注入时不必再解码（省一次 atob/TextDecoder） */
export interface ResourceRecord {
  url: string
  /** 响应头 content-type（拼 data URI 用；缺省按 application/octet-stream） */
  mime: string
  /** data URI 的载荷（base64） */
  base64: string
  /** 原始文本（`GM_getResourceText` 直接给这个；二进制资源解出的是乱码，与 TM 一致） */
  text: string
  fetchedAt: number
}

/** 批量查缓存：返回 url → 记录（未命中不出现在 map 里） */
export function getResourceCache(urls: string[]): Promise<Map<string, ResourceRecord>> {
  return cacheGetAll<ResourceRecord>(getResourceCacheDb(), STORE, urls, '资源缓存')
}

/** 批量写缓存（相同 url 覆盖）。写失败不阻断（下次重抓即可） */
export function setResourceCache(items: ResourceRecord[]): Promise<void> {
  return cachePutAll(getResourceCacheDb(), STORE, items)
}

/** 清空全部缓存（手动重抓用） */
export function clearResourceCache(): Promise<void> {
  return cacheClear(getResourceCacheDb(), STORE, '资源缓存')
}

// —— 抓取层（注册 / 注入时抓）——
const RESOURCE_TIMEOUT_MS = 15000

/** 一个 `@resource` 声明（名字 + 地址） */
export interface ResourceDecl {
  name: string
  url: string
}

export interface ResourceFetchResult {
  name: string
  url: string
  ok: boolean
  /** 注入时用的 data URI（ok 时才有） */
  dataUrl?: string
  text?: string
  error?: string
}

/**
 * 按声明抓取 `@resource` 内容：命中缓存即用、未命中 SW fetch 后写缓存。
 * 单条失败返回 `{ ok:false, error }`，**不抛**（不让一条失败阻断整批 / 整脚本注入）。
 *
 * 文本与 base64 **同一次响应里都取出**：`GM_getResourceText` 要文本、`GM_getResourceURL` 要 data URI，
 * 脚本两个都调很常见 —— 分别抓两次是浪费（也是 TM 只抓一次的理由）。
 */
export async function fetchResourceSources(decls: ResourceDecl[]): Promise<ResourceFetchResult[]> {
  if (!decls.length) return []
  let cached: Map<string, ResourceRecord>
  try {
    cached = await getResourceCache(decls.map((d) => d.url))
  } catch {
    cached = new Map()
  }
  const results: ResourceFetchResult[] = []
  const fresh: ResourceRecord[] = []
  for (const decl of decls) {
    const hit = cached.get(decl.url)
    if (hit) {
      results.push({
        name: decl.name,
        url: decl.url,
        ok: true,
        dataUrl: `data:${hit.mime};base64,${hit.base64}`,
        text: hit.text,
      })
      continue
    }
    try {
      const resp = await fetchWithTimeout(decl.url, RESOURCE_TIMEOUT_MS)
      if (!resp.ok) {
        results.push({ name: decl.name, url: decl.url, ok: false, error: `HTTP ${resp.status}` })
        continue
      }
      const mime = (resp.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim()
      const buf = new Uint8Array(await resp.arrayBuffer())
      const base64 = bytesToBase64(buf)
      const text = new TextDecoder().decode(buf)
      results.push({
        name: decl.name,
        url: decl.url,
        ok: true,
        dataUrl: `data:${mime};base64,${base64}`,
        text,
      })
      fresh.push({ url: decl.url, mime, base64, text, fetchedAt: Date.now() })
    } catch (e) {
      const msg = errorText(e)
      results.push({ name: decl.name, url: decl.url, ok: false, error: msg })
    }
  }
  if (fresh.length) void setResourceCache(fresh).catch(() => {})
  return results
}
