// @require 外部依赖源码缓存 + 抓取（SW 独占读写；与 duoling-usdata 分离，生命周期不同）。
//
// 为什么独立一库：require 缓存是**外部库的快照**，可清（用户清缓存 / 库更新后重抓），
// 与脚本自己写的数据（duoling-usdata）信任级与演进节奏不同。「删脚本」不该动 require 缓存，
// 「清 require 缓存」也不该动脚本数据。
//
// 缓存策略（决策 A1）：url 不变即命中、永不过期，仅手动 clearRequireCache 时重抓。
// 抓取策略（决策 C1）：注册时由 SW 内 fetch 抓取，受 <all_urls> host 权限豁免 CORS。
// 失败策略（决策 B1）：单条抓取失败只记错误、跳过该依赖，不阻断脚本整体注入。

const DB_NAME = 'duoling-require-cache'
const DB_VERSION = 1
const STORE = 'requires'

interface RequireCacheRecord {
  url: string
  code: string
  fetchedAt: number
}

let dbPromise: Promise<IDBDatabase> | undefined

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'url' })
        }
      }
      req.onsuccess = () => {
        const db = req.result
        // 别处要升级版本时先放手，否则对方一直 blocked；下次调用重新打开
        db.onversionchange = () => {
          db.close()
          dbPromise = undefined
        }
        resolve(db)
      }
      req.onerror = () => reject(req.error ?? new Error('无法打开 require 缓存库'))
      req.onblocked = () => reject(new Error('require 缓存库被其它上下文占用，无法升级'))
    }).catch((e: unknown) => {
      dbPromise = undefined // 失败不缓存，下次重试
      throw e
    })
  }
  return dbPromise
}

/** 批量查缓存：返回 url → code（未命中不出现在 map 里） */
export async function getRequireCache(urls: string[]): Promise<Map<string, string>> {
  if (!urls.length) return new Map()
  const db = await openDb()
  const out = new Map<string, string>()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    let remaining = urls.length
    const done = () => {
      if (--remaining === 0) resolve()
    }
    for (const url of urls) {
      const req = store.get(url)
      req.onsuccess = () => {
        const rec = req.result as RequireCacheRecord | undefined
        if (rec) out.set(url, rec.code)
        done()
      }
      req.onerror = () => done() // 单条失败不阻断整批
    }
    tx.onerror = () => reject(tx.error ?? new Error('require 缓存读取失败'))
  })
  return out
}

/** 批量写缓存（相同 url 覆盖）。写失败不阻断（下次重抓即可） */
export async function setRequireCache(items: { url: string; code: string }[]): Promise<void> {
  if (!items.length) return
  let db: IDBDatabase
  try {
    db = await openDb()
  } catch {
    return
  }
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const now = Date.now()
    for (const it of items) store.put({ url: it.url, code: it.code, fetchedAt: now })
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve() // 写失败不阻断
    tx.onabort = () => resolve()
  })
}

/** 清空全部缓存（库更新后手动重抓用） */
export async function clearRequireCache(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('require 缓存清除失败'))
  })
}

// —— 抓取层（决策 C1：注册时抓）——
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
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), REQUIRE_TIMEOUT_MS)
      let resp: Response
      try {
        resp = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: ctrl.signal })
      } finally {
        clearTimeout(timer)
      }
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
