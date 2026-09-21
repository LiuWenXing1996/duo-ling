// 扩展「自己的配置 / 基础设施键」的底层存储：独立 IndexedDB 库 duoling-app。
//
// 装三类（从 chrome.storage.local 迁入，storage 侧自此清零）：
//   · modelProfiles —— 模型配置（密文载荷 + activeProfileId，见 model-store.ts）
//   · apiKeyDek     —— API Key 落盘加密的 DEK（见 key-cipher.ts）
//   · pageSecret    —— MAIN 世界共享桩的注册密钥（见 userscripts/engine.ts）
//
// 与脚本数据（duoling-usdata）、观测数据（duoling-runtime）分库：这些都是**扩展自己的
// 小数据**——有固定键、写频极低（保存配置 / 首次生成），跟「脚本不可信数据」「高频观测
// 数据」的演进节奏都不同，一个泛用 kv store 即可，不必为它们各建 schema。
//
// 读写方：扩展页 / SW 都可用（同源 IndexedDB）；offscreen 不 import 本模块
// （模型配置经 SW 命令 / 推送获取，见 offscreen-main.ts）。node 单测 fake-indexeddb/auto 直测。

const DB_NAME = 'duoling-app'
const DB_VERSION = 1

const KV_STORE = 'kv'

interface KvRecord {
  key: string
  value: unknown
}

let dbPromise: Promise<IDBDatabase> | undefined

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(KV_STORE)) {
          db.createObjectStore(KV_STORE, { keyPath: 'key' })
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
      req.onerror = () => reject(req.error ?? new Error('无法打开本地数据'))
      req.onblocked = () => reject(new Error('本地数据被其它页面占用，无法升级'))
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
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const db = await openDb()
    try {
      const tx = db.transaction(KV_STORE, mode)
      return await run(tx)
    } catch (e) {
      dbPromise = undefined
      if (attempt < 2 && isDeadConnection(e)) continue
      throw e
    }
  }
}

/** 读一个键（不存在返回 undefined） */
export async function get<T>(key: string): Promise<T | undefined> {
  return runTx('readonly', async (tx) => {
    const rec = await request<KvRecord | undefined>(tx.objectStore(KV_STORE).get(key))
    return rec?.value as T | undefined
  })
}

/** 写一个键（整体覆盖） */
export async function set(key: string, value: unknown): Promise<void> {
  await runTx('readwrite', async (tx) => {
    tx.objectStore(KV_STORE).put({ key, value } satisfies KvRecord)
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('保存设置失败'))
      tx.onabort = () => reject(tx.error ?? new Error('保存设置被中止'))
    })
  })
}

/**
 * 原子读-改-写：在**单个 readwrite 事务**内读旧值、交给 mutate 产出新值、写回。
 *
 * 为什么必须提供它：跨上下文并发写同一个键会丢更新。典型场景是 tab 归属映射
 * （`convByTab`，见 conversation-tab-map.ts）——「面板在 A tab 记一条」与
 * 「SW 在 B tab 关掉时删一条」可能交错，各自 get 到同一份旧值再 set，后写的把先写的抹掉。
 * IndexedDB 会把同一 store 的 readwrite 事务串行化，因此把读与写放进**同一个事务**
 * 就是原子操作（同 conversation-store 的 takeNextSeq）；拆成两个独立事务则不是。
 *
 * 返回 mutate 产出的新值（调用方通常要接着用它）。
 */
export async function update<T>(key: string, mutate: (prev: T | undefined) => T): Promise<T> {
  return runTx('readwrite', async (tx) => {
    const store = tx.objectStore(KV_STORE)
    const prev = (await request<KvRecord | undefined>(store.get(key)))?.value as T | undefined
    const next = mutate(prev)
    store.put({ key, value: next } satisfies KvRecord)
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('保存设置失败'))
      tx.onabort = () => reject(tx.error ?? new Error('保存设置被中止'))
    })
    return next
  })
}

/** 删除一个键（键不存在是 no-op） */
export async function remove(key: string): Promise<void> {
  await runTx('readwrite', async (tx) => {
    tx.objectStore(KV_STORE).delete(key)
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('删除设置失败'))
      tx.onabort = () => reject(tx.error ?? new Error('删除设置被中止'))
    })
  })
}

// —— 测试辅助（仅单测使用；清空全部记录保证用例隔离）——

export async function clearAllForTests(): Promise<void> {
  await runTx('readwrite', async (tx) => {
    tx.objectStore(KV_STORE).clear()
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('清空设置失败'))
      tx.onabort = () => reject(tx.error ?? new Error('清空设置被中止'))
    })
  })
}
