// GM 值存储的写出口枢纽（自 src/lib/userscripts/store.ts 的 GM 段上移）。
//
// 落盘在 duoling-usdata 库（usdata-db.ts，复合主键 [uuid, key]）；本文件管的是
// 「写 + 发事件」的语义层：值未变化的 set、删除不存在的键都不发事件
// （与 chrome.storage.onChanged 行为一致）。变更事件从写出口直发（IDB 无通知），
// dl-port 订阅它把 store.change 帧推回脚本世界。
//
// 写出口 = 本文件这几个函数（dl-bridge dispatch 是唯一调用方）。
import * as usdata from './usdata-db'

export interface GmValueChange {
  uuid: string
  key: string
  /** true = 键被删除（帧上 value 置 null）；false = 新值写入 */
  deleted: boolean
  /** 新值（deleted 时为 null）；随事件携带，订阅方免回读 */
  value: unknown
  /**
   * 变化前的值。支撑 `GM_addValueChangeListener(key, (k, oldValue, newValue, remote))` 的
   * 第二参；键不存在时为 undefined。
   */
  oldValue?: unknown
  /**
   * 发起写的实例 connId（包装层随 `store.set` 带上）。
   * 推送侧据此判 `remote`：与发起者同 connId 的 Port 是「本实例自己写的」（false），
   * 其余是「别的标签页 / 框架写的」（true）；缺省 = 来源未知（后台内部写）→ 一律按 remote 处理。
   */
  writerConnId?: string
}

type GmValueListener = (change: GmValueChange) => void

const gmValueListeners = new Set<GmValueListener>()

/** 订阅 GM 值变更（dl-port 的 store.watch 下行推送经此接线；返回退订函数） */
export function onGmValueChange(listener: GmValueListener): () => void {
  gmValueListeners.add(listener)
  return () => gmValueListeners.delete(listener)
}

function emitGmChange(change: GmValueChange): void {
  for (const cb of gmValueListeners) {
    try {
      cb(change)
    } catch {
      // 单个订阅者异常不阻断其它订阅者与写入本身
    }
  }
}

export async function getGMValue(uuid: string, key: string): Promise<unknown> {
  return usdata.getGmValue(uuid, key)
}

export async function setGMValue(
  uuid: string,
  key: string,
  value: unknown,
  writerConnId?: string,
): Promise<void> {
  const prev = await usdata.getGmValue(uuid, key)
  await usdata.setGmValue(uuid, key, value)
  // 值未变化不发事件（storage.onChanged 同款语义）；结构化克隆值按 Json 契约可比
  if (JSON.stringify(prev) !== JSON.stringify(value)) {
    // 可选字段只在有值时挂上 —— 事件要过结构化克隆过桥，留 undefined 键只会让帧更脏
    emitGmChange({
      uuid,
      key,
      deleted: false,
      value,
      ...(prev !== undefined ? { oldValue: prev } : {}),
      ...(writerConnId ? { writerConnId } : {}),
    })
  }
}

export async function deleteGMValue(
  uuid: string,
  key: string,
  writerConnId?: string,
): Promise<void> {
  const prev = await usdata.getGmValue(uuid, key)
  if (prev === undefined) return // 键本就不存在：不写不发事件（同 storage.remove）
  await usdata.deleteGmValue(uuid, key)
  emitGmChange({ uuid, key, deleted: true, value: null, oldValue: prev, ...(writerConnId ? { writerConnId } : {}) })
}

/**
 * 批量写（GM_setValues 的落点）：一次事务落盘，**逐键**发变更事件。
 *
 * 事件粒度照旧是「一键一帧」而不是「一批一帧」——订阅侧（`GM_addValueChangeListener`）
 * 的语义按 key 走，合成一帧它没法派发；且值没变化的键不发（与单键版同款）。
 */
export async function setGMValues(
  uuid: string,
  entries: Record<string, unknown>,
  writerConnId?: string,
): Promise<void> {
  const keys = Object.keys(entries)
  if (!keys.length) return
  const prev = await usdata.getGmValues(uuid, keys)
  await usdata.setGmValues(uuid, entries)
  for (const key of keys) {
    // 结构化克隆值按 Json 契约可比（同单键版的判据）
    if (JSON.stringify(prev[key]) === JSON.stringify(entries[key])) continue
    const oldValue = prev[key]
    emitGmChange({
      uuid,
      key,
      deleted: false,
      value: entries[key],
      ...(oldValue !== undefined ? { oldValue } : {}),
      ...(writerConnId ? { writerConnId } : {}),
    })
  }
}

/**
 * 批量删（GM_deleteValues 的落点）：一次事务落盘，只对**真删掉**的键逐键发删除事件。
 * 不存在的键静默跳过（同 deleteGMValue 的 storage.remove 语义）。
 */
export async function deleteGMValues(
  uuid: string,
  keys: string[],
  writerConnId?: string,
): Promise<void> {
  if (!keys.length) return
  const removed = await usdata.deleteGmValues(uuid, keys)
  for (const { key, oldValue } of removed) {
    emitGmChange({
      uuid,
      key,
      deleted: true,
      value: null,
      oldValue,
      ...(writerConnId ? { writerConnId } : {}),
    })
  }
}

/** 列出某脚本存过的全部键 */
export async function listGMKeys(uuid: string): Promise<string[]> {
  return usdata.listGmKeys(uuid)
}

/** 某脚本的全部键值快照（注入时的值预载 + 包装层全量校准用） */
export async function getAllGMValues(uuid: string): Promise<Record<string, unknown>> {
  return usdata.listGmValues(uuid)
}

/** 批量取若干键（`GM.getValues` 的落点）：只回存在的键，不把整份存储搬过桥 */
export async function getGMValues(uuid: string, keys: string[]): Promise<Record<string, unknown>> {
  return usdata.getGmValues(uuid, keys)
}

/**
 * 清空某脚本的全部存储值；被删的键逐个发删除事件（对齐 storage.onChanged 逐键语义）。
 *
 * **不带 oldValue**：批量操作不逐个回读旧值，订阅方的 oldValue 为 undefined（帧上是 null）。
 * 要精确的旧值请在 clear 前自己 listValues + getValue 读一遍。
 */
export async function clearGMValues(uuid: string, writerConnId?: string): Promise<void> {
  const deletedKeys = await usdata.clearGmValues(uuid)
  for (const key of deletedKeys) {
    // 逐个发删除事件（对齐 storage.onChanged 逐键语义）；被删的键必然有旧值
    emitGmChange({ uuid, key, deleted: true, value: null, ...(writerConnId ? { writerConnId } : {}) })
  }
}
