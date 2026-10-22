//
// 装三类（从 chrome.storage.local 迁入，storage 侧自此清零）：
//   · modelProfiles —— 模型配置（密文载荷 + activeProfileId，见 model-store.ts）
//   · apiKeyDek     —— API Key 落盘加密的 DEK（见 key-cipher.ts）
//   · pageSecret    —— 脚本桥的共享密钥（见 userscripts/engine.ts）
//
// 读写方：扩展页 / SW 都可用（同源 IndexedDB）；offscreen 不 import 本模块

import { APP_KV_STORE as KV_STORE, getAppDexie } from '../db/app'

interface KvRecord {
  key: string
  value: unknown
}

/** 读一个键（不存在返回 undefined） */
export async function get<T>(key: string): Promise<T | undefined> {
  const rec = await getAppDexie().kv.get(key)
  return rec?.value as T | undefined
}

/** 写一个键（整体覆盖） */
export async function set(key: string, value: unknown): Promise<void> {
  await getAppDexie().kv.put({ key, value } satisfies KvRecord)
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
  return getAppDexie().transaction('rw', KV_STORE, async (tx) => {
    const table = tx.table<KvRecord, string>(KV_STORE)
    const prev = (await table.get(key))?.value as T | undefined
    const next = mutate(prev)
    await table.put({ key, value: next } satisfies KvRecord)
    return next
  })
}

/** 删除一个键（键不存在是 no-op） */
export async function remove(key: string): Promise<void> {
  await getAppDexie().kv.delete(key)
}

// —— 测试辅助（仅单测使用；清空全部记录保证用例隔离）——

export async function clearAllForTests(): Promise<void> {
  await getAppDexie().kv.clear()
}
