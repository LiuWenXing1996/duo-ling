// `@resource` 命名资源的内容缓存 + 抓取（SW 独占读写；与 @require 缓存分库）。
//
// 为什么与 require-cache 分库：两者生命周期不同 —— require 是**代码**（同名 url 换了内容会直接影响
// 脚本行为，故语义上属于「依赖快照」），resource 是**素材**（图标 / 样式 / 数据文件，通常很大且很少变）。
// 混在一个库里的代价是清理粒度变粗（清 require 会把资源也清掉，反之亦然）。
//
// 与 TM 的对应：`GM_getResourceText(name)` 拿文本、`GM_getResourceURL(name)` 拿 **base64 data URI**
// （TM 文档原话：「获取在脚本头部用 @resource 标签预定义的的 base64 编码的 URI」）。两者都是**同步** API，
// 所以内容必须在注入前就绪 —— 本模块在注册/注入路径上被调用，把内容备好，注入时内联进包装层
// （与 @require 同款「注册时抓取、注入时就绪」，见 engine.ts）。
//
// 抓取策略：SW 内 fetch，受 <all_urls> host 权限豁免 CORS；url 不变即命中、永不过期。
// 失败策略：单条失败只记错误、跳过该资源（脚本拿到 undefined），不阻断整体注入。

const DB_NAME = 'duoling-resource-cache'
const DB_VERSION = 1
const STORE = 'resources'

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
      req.onerror = () => reject(req.error ?? new Error('无法打开资源缓存'))
      req.onblocked = () => reject(new Error('资源缓存被其它页面占用，无法升级'))
    }).catch((e: unknown) => {
      dbPromise = undefined // 失败不缓存，下次重试
      throw e
    })
  }
  return dbPromise
}

/** 批量查缓存：返回 url → 记录（未命中不出现在 map 里） */
export async function getResourceCache(urls: string[]): Promise<Map<string, ResourceRecord>> {
  if (!urls.length) return new Map()
  const db = await openDb()
  const out = new Map<string, ResourceRecord>()
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
        const rec = req.result as ResourceRecord | undefined
        if (rec) out.set(url, rec)
        done()
      }
      req.onerror = () => done() // 单条失败不阻断整批
    }
    tx.onerror = () => reject(tx.error ?? new Error('资源缓存读取失败'))
  })
  return out
}

/** 批量写缓存（相同 url 覆盖）。写失败不阻断（下次重抓即可） */
export async function setResourceCache(items: ResourceRecord[]): Promise<void> {
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
    for (const it of items) store.put(it)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve() // 写失败不阻断
    tx.onabort = () => resolve()
  })
}

/** 清空全部缓存（手动重抓用） */
export async function clearResourceCache(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('资源缓存清除失败'))
  })
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

/** 把字节编成 base64（分块，避免 apply 参数上限） */
function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(s)
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
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), RESOURCE_TIMEOUT_MS)
      let resp: Response
      try {
        resp = await fetch(decl.url, { credentials: 'omit', redirect: 'follow', signal: ctrl.signal })
      } finally {
        clearTimeout(timer)
      }
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
      const msg = e instanceof Error ? e.message : String(e)
      results.push({ name: decl.name, url: decl.url, ok: false, error: msg })
    }
  }
  if (fresh.length) void setResourceCache(fresh).catch(() => {})
  return results
}
