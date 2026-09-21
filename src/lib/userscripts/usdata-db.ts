// 用户脚本「自己存的数据」的底层存储：独立 IndexedDB 库 duoling-usdata（SW 独占写）。
//
// 装两类数据（从 chrome.storage 迁入，键空间概念随之变成 object store）：
//   · gm  —— GM 值（原 us:gm:<uuid>:<key>），复合主键 [uuid, key]
//   · tab —— GM tab 标签页级存储（原 us:tab:<uuid>:<tabId>），复合主键 [uuid, tabId]
//
// 为什么单独一库（与 duoling-runtime 观测数据分开）：这里放的是**脚本自己写的数据**
// ——不可信、无上限（此前受 chrome.storage 10MB 配额约束，正是迁移动机）、生命周期随
// 脚本/tab 删除；观测数据（错误日志 / 运行统计）是我们自己生成的、有环形上限，两者
// 信任级与演进节奏不同。「删脚本 = 清该脚本数据」在这库里就是一次 range delete。
//
// 单写方约定：写 API 只许 SW 调用（写侧全部经 dl-bridge / store.ts 汇入）；
// 本模块不感知 chrome API，node 单测用 fake-indexeddb/auto 直测。
//
// 范围查询的键序技巧（已弃用）：最初想用 bound([uuid,''],[uuid,[]]) 的「array > string」
// 键序覆盖任意第二键——真实 Chrome 按 spec 支持，但 fake-indexeddb 的比较实现不认（实测
// getAll 返回空，单测直接暴露）。故改用 by_uuid 二级索引：查询语义等价、实现也更直白。

const DB_NAME = 'duoling-usdata'
const DB_VERSION = 1

const GM_STORE = 'gm'
const TAB_STORE = 'tab'

interface GmRecord {
  uuid: string
  key: string
  value: unknown
}

interface TabRecord {
  uuid: string
  tabId: number
  value: unknown
}

let dbPromise: Promise<IDBDatabase> | undefined

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(GM_STORE)) {
          const gm = db.createObjectStore(GM_STORE, { keyPath: ['uuid', 'key'] })
          gm.createIndex('by_uuid', 'uuid')
        }
        if (!db.objectStoreNames.contains(TAB_STORE)) {
          const tab = db.createObjectStore(TAB_STORE, { keyPath: ['uuid', 'tabId'] })
          tab.createIndex('by_uuid', 'uuid')
          tab.createIndex('by_tabId', 'tabId')
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
      req.onerror = () => reject(req.error ?? new Error('无法打开脚本数据'))
      req.onblocked = () => reject(new Error('脚本数据被其它页面占用，无法升级'))
    }).catch((e: unknown) => {
      dbPromise = undefined // 失败不缓存，下次重试
      throw e
    })
  }
  return dbPromise
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('本地数据读取失败'))
  })
}

// 连接已死（被外部删库 / 强制关闭）：transaction() 会同步抛 InvalidStateError
function isDeadConnection(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'InvalidStateError'
}

async function runTx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction, store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const db = await openDb()
    try {
      const tx = db.transaction(storeName, mode)
      return await run(tx, tx.objectStore(storeName))
    } catch (e) {
      dbPromise = undefined
      if (attempt < 2 && isDeadConnection(e)) continue
      throw e
    }
  }
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return runTx(storeName, mode, (_tx, store) => request(run(store)))
}

/** 某脚本在 store 内的全部记录：经 by_uuid 索引（复合键的键序技巧不可靠，见文件头） */
async function getAllByUuid<T>(storeName: string, uuid: string): Promise<T[]> {
  return runTx(storeName, 'readonly', async (tx, store) => {
    const recs = await request<T[]>(store.index('by_uuid').getAll(uuid))
    return recs ?? []
  })
}

// —— GM 值存储（gm store）——

export async function getGmValue(uuid: string, key: string): Promise<unknown> {
  const rec = await withStore<GmRecord | undefined>(GM_STORE, 'readonly', (s) => s.get([uuid, key]))
  return rec?.value
}

export async function setGmValue(uuid: string, key: string, value: unknown): Promise<void> {
  await withStore(GM_STORE, 'readwrite', (s) => s.put({ uuid, key, value }))
}

export async function deleteGmValue(uuid: string, key: string): Promise<void> {
  await withStore(GM_STORE, 'readwrite', (s) => s.delete([uuid, key]))
}

/** 列出某脚本存过的全部键（索引查询，不再全库扫描） */
export async function listGmKeys(uuid: string): Promise<string[]> {
  const recs = await getAllByUuid<GmRecord>(GM_STORE, uuid)
  return recs.map((r) => r.key)
}

/**
 * 某脚本的全部键值快照（键 → 值）。
 *
 * 两个调用方：注入时的**值预载**（同步 `GM_getValue` 的底座，见 gm-wrapper.ts）与
 * 包装层 connect 后的**全量校准**（覆盖 Port 就绪前的窗口）。
 */
export async function listGmValues(uuid: string): Promise<Record<string, unknown>> {
  const recs = await getAllByUuid<GmRecord>(GM_STORE, uuid)
  const out: Record<string, unknown> = {}
  for (const r of recs) out[r.key] = r.value
  return out
}

/** 清空某脚本的全部存储值，返回被删的键（供写出口逐键发变更事件） */
export async function clearGmValues(uuid: string): Promise<string[]> {
  return runTx(GM_STORE, 'readwrite', async (tx, store) => {
    const recs = await request<GmRecord[]>(store.index('by_uuid').getAll(uuid))
    for (const r of recs ?? []) store.delete([r.uuid, r.key])
    return new Promise<string[]>((resolve, reject) => {
      tx.oncomplete = () => resolve((recs ?? []).map((r) => r.key))
      tx.onerror = () => reject(tx.error ?? new Error('清空脚本数据失败'))
      tx.onabort = () => reject(tx.error ?? new Error('清空脚本数据被中止'))
    })
  })
}

// —— GM tab（tab store）——

export async function getTabValue(uuid: string, tabId: number): Promise<unknown> {
  const rec = await withStore<TabRecord | undefined>(TAB_STORE, 'readonly', (s) =>
    s.get([uuid, tabId]),
  )
  return rec?.value
}

export async function putTabValue(uuid: string, tabId: number, value: unknown): Promise<void> {
  await withStore(TAB_STORE, 'readwrite', (s) => s.put({ uuid, tabId, value }))
}

/** 全部标签页对象快照：键为 tabId 字符串（对齐 GM_getTabs）。仅本脚本自身 */
export async function listTabValues(uuid: string): Promise<Record<string, unknown>> {
  const recs = await getAllByUuid<TabRecord>(TAB_STORE, uuid)
  const out: Record<string, unknown> = {}
  for (const r of recs) out[String(r.tabId)] = r.value
  return out
}

/** 删除某 tab 的全部 tab 存储记录（tab 关闭清理；经 by_tabId 索引定位，不全库扫描） */
export async function deleteTabsByTabId(tabId: number): Promise<void> {
  await runTx(TAB_STORE, 'readwrite', async (tx, store) => {
    const idx = store.index('by_tabId')
    const recs = await request<TabRecord[]>(idx.getAll(tabId))
    for (const r of recs) store.delete([r.uuid, r.tabId])
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('清理标签页数据失败'))
      tx.onabort = () => reject(tx.error ?? new Error('清理标签页数据被中止'))
    })
  })
}

/**
 * 启动对账：删掉「tab 已不存在」的孤儿记录（兜浏览器崩溃 / SW 错过 onRemoved）。
 * alive = 当前存活的 tabId 集合。
 */
export async function pruneTabsNotIn(alive: Set<number>): Promise<void> {
  await runTx(TAB_STORE, 'readwrite', async (tx, store) => {
    const recs = await request<TabRecord[]>(store.getAll())
    const orphans = (recs ?? []).filter((r) => !alive.has(r.tabId))
    for (const r of orphans) store.delete([r.uuid, r.tabId])
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('对账清理标签页数据失败'))
      tx.onabort = () => reject(tx.error ?? new Error('对账清理标签页数据被中止'))
    })
  })
}

// —— 测试辅助（仅单测使用；清空全部记录保证用例隔离）——

export async function clearAllForTests(): Promise<void> {
  await withStore(GM_STORE, 'readwrite', (s) => s.clear())
  await withStore(TAB_STORE, 'readwrite', (s) => s.clear())
}
