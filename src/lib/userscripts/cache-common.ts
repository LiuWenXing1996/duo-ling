// @require / @resource 两个缓存库的共享底层。两库生命周期不同（依赖代码快照 vs
// 素材数据），故分库（见各自文件头）；但「url 不变即命中、永不过期」的存储骨架与
// 「单条失败不阻断整批 / 写失败不阻断」的容错策略完全同构，收拢到此处。
import type { IdbOpener } from '../idb-core'

/** 批量查缓存：返回 url → 记录（未命中不出现在 map 里；单条失败不阻断整批） */
export async function cacheGetAll<T>(
  opener: IdbOpener,
  storeName: string,
  urls: string[],
  readErrorLabel: string,
): Promise<Map<string, T>> {
  if (!urls.length) return new Map()
  const db = await opener.open()
  const out = new Map<string, T>()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const store = tx.objectStore(storeName)
    let remaining = urls.length
    const done = () => {
      if (--remaining === 0) resolve()
    }
    for (const url of urls) {
      const req = store.get(url)
      req.onsuccess = () => {
        const rec = req.result as T | undefined
        if (rec) out.set(url, rec)
        done()
      }
      req.onerror = () => done() // 单条失败不阻断整批
    }
    tx.onerror = () => reject(tx.error ?? new Error(`${readErrorLabel}读取失败`))
  })
  return out
}

/** 批量写缓存（相同 url 覆盖）。写失败不阻断（下次重抓即可） */
export async function cachePutAll(
  opener: IdbOpener,
  storeName: string,
  records: Array<{ url: string }>,
): Promise<void> {
  if (!records.length) return
  let db: IDBDatabase
  try {
    db = await opener.open()
  } catch {
    return
  }
  await new Promise<void>((resolve) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    for (const it of records) store.put(it)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve() // 写失败不阻断
    tx.onabort = () => resolve()
  })
}

/** 清空全部缓存（手动重抓用） */
export async function cacheClear(
  opener: IdbOpener,
  storeName: string,
  what: string,
): Promise<void> {
  const db = await opener.open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error(`${what}清除失败`))
  })
}

/** 限时抓取：credentials omit + redirect follow + 到点 abort（网络错误由调用方按单条容错处理） */
export async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { credentials: 'omit', redirect: 'follow', signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}
