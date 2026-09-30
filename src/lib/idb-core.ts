// IndexedDB 打开与事务的共享样板。本扩展按信任级 / 生命周期分库（见 ARCHITECTURE.md
// 「存储」），各库模块的 openDb / request / 死连接重试完全同构，收拢到此处；
// 各库只保留自己的 schema（upgrade 回调）与业务读写。

export interface IdbOpener {
  open(): Promise<IDBDatabase>
  /** 连接已死（外部删库后 transaction 抛 InvalidStateError），下次调用重开 */
  invalidate(): void
}

/**
 * 打开器工厂：缓存连接，失败不缓存（下次重试）。
 * onversionchange 主动放手——别处要升级版本时本连接不放手，对方会一直 blocked；
 * 放手后下次调用重新打开。
 */
export function createIdbOpener(options: {
  name: string
  version: number
  /** 对象库与索引的建表（onupgradeneeded 内调用） */
  upgrade: (db: IDBDatabase) => void
  /** 错误文案主体：拼出「无法打开X」/「X被其它页面占用，无法升级」 */
  label: string
}): IdbOpener {
  let dbPromise: Promise<IDBDatabase> | undefined
  return {
    open(): Promise<IDBDatabase> {
      if (!dbPromise) {
        dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open(options.name, options.version)
          req.onupgradeneeded = () => options.upgrade(req.result)
          req.onsuccess = () => {
            const db = req.result
            db.onversionchange = () => {
              db.close()
              dbPromise = undefined
            }
            resolve(db)
          }
          req.onerror = () => reject(req.error ?? new Error(`无法打开${options.label}`))
          req.onblocked = () => reject(new Error(`${options.label}被其它页面占用，无法升级`))
        }).catch((e: unknown) => {
          dbPromise = undefined // 失败不缓存，下次重试
          throw e
        })
      }
      return dbPromise
    },
    invalidate(): void {
      dbPromise = undefined
    },
  }
}

/** 把 IDBRequest 包成 Promise（请求级错误） */
export function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('本地数据读取失败'))
  })
}

// 连接已死（被外部删库 / 强制关闭）：transaction() 会同步抛 InvalidStateError
export function isDeadConnection(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'InvalidStateError'
}

/**
 * 开事务执行（含死连接兜底）。
 * 外部删库（如 DevTools 面板强删）不触发 onversionchange，缓存的连接死后 open 永远拿到死连接，
 * 之后每次 transaction 都报 "connection is closing"——故这里捕获后重置缓存、重开一次。
 * 库被删本身无害：重新 open 时 onupgradeneeded 会把表建回来。
 */
export async function idbRunTx<T>(
  opener: IdbOpener,
  storeNames: string | string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const names = Array.isArray(storeNames) ? storeNames : [storeNames]
  for (let attempt = 1; ; attempt++) {
    const db = await opener.open()
    try {
      const tx = db.transaction(names, mode)
      return await run(tx)
    } catch (e) {
      opener.invalidate()
      if (attempt < 2 && isDeadConnection(e)) continue
      throw e
    }
  }
}
