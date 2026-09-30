// @require 外部依赖源码缓存 + 抓取（SW 独占读写；与 duoling-usdata 分离，生命周期不同）。
//
// 为什么独立一库：require 缓存是**外部库的快照**，可清（用户清缓存 / 库更新后重抓），
// 与脚本自己写的数据（duoling-usdata）信任级与演进节奏不同。「删脚本」不该动 require 缓存，
// 「清 require 缓存」也不该动脚本数据。
//
// 缓存策略：url 不变即命中、永不过期，仅手动 clearRequireCache 时重抓。
// 抓取策略：注册时由 SW 内 fetch 抓取，受 <all_urls> host 权限豁免 CORS。
// 失败策略：单条抓取失败只记错误、跳过该依赖，不阻断脚本整体注入。

import { createIdbOpener } from '../idb-core'
import { cacheClear, cacheGetAll, cachePutAll, fetchWithTimeout } from './cache-common'

const DB_NAME = 'duoling-require-cache'
const DB_VERSION = 1
const STORE = 'requires'

interface RequireCacheRecord {
  url: string
  code: string
  fetchedAt: number
}

const opener = createIdbOpener({
  name: DB_NAME,
  version: DB_VERSION,
  upgrade: (db) => {
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE, { keyPath: 'url' })
    }
  },
  label: '依赖缓存',
})

/** 批量查缓存：返回 url → code（未命中不出现在 map 里） */
export async function getRequireCache(urls: string[]): Promise<Map<string, string>> {
  const recs = await cacheGetAll<RequireCacheRecord>(opener, STORE, urls, '依赖缓存')
  const out = new Map<string, string>()
  for (const [url, rec] of recs) out.set(url, rec.code)
  return out
}

/** 批量写缓存（相同 url 覆盖）。写失败不阻断（下次重抓即可） */
export async function setRequireCache(items: { url: string; code: string }[]): Promise<void> {
  const now = Date.now()
  return cachePutAll(
    opener,
    STORE,
    items.map((it) => ({ url: it.url, code: it.code, fetchedAt: now })),
  )
}

/** 清空全部缓存（库更新后手动重抓用） */
export function clearRequireCache(): Promise<void> {
  return cacheClear(opener, STORE, '依赖缓存')
}

// —— 抓取层（注册时抓）——
const REQUIRE_TIMEOUT_MS = 15000

export interface RequireFetchResult {
  url: string
  ok: boolean
  code?: string
  error?: string
}

/**
 * 按序抓取 @require 源码：命中缓存即用、未命中 SW fetch 后写缓存。
 * 单条失败返回 { ok:false, error }，**不抛**（不让一条失败阻断整批 / 整脚本注册）。
 */
export async function fetchRequireSources(urls: string[]): Promise<RequireFetchResult[]> {
  if (!urls.length) return []
  let cached: Map<string, string>
  try {
    cached = await getRequireCache(urls)
  } catch {
    cached = new Map()
  }
  const results: RequireFetchResult[] = []
  for (const url of urls) {
    const hit = cached.get(url)
    if (hit != null) {
      results.push({ url, ok: true, code: hit })
      continue
    }
    try {
      const resp = await fetchWithTimeout(url, REQUIRE_TIMEOUT_MS)
      if (!resp.ok) {
        results.push({ url, ok: false, error: `HTTP ${resp.status}` })
        continue
      }
      const code = await resp.text()
      results.push({ url, ok: true, code })
      void setRequireCache([{ url, code }]).catch(() => {})
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      results.push({ url, ok: false, error: msg })
    }
  }
  return results
}
