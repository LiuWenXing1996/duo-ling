// GM_getTab 标签页级存储（tab 域）：duoling-usdata 库的 tab store，
// 复合主键 [uuid, tabId]（原 chrome.storage 键空间 us:tab:<uuid>:<tabId>），
// 每脚本每 tab 一记录，避免多 tab 并发互相覆盖。
//
// 生命周期（挂载 / 对账）收在 mountTabStoreCleanup：tab 关闭即删该 tab 全部记录，
// SW 冷启动再对账一遍孤儿记录（兜浏览器崩溃 / SW 错过 onRemoved）。
import type { Json } from '@duoling/shared'
import * as usdata from '../usdata-db'

/** 读当前标签页对象 */
export async function getTabValue(uuid: string, tabId: number): Promise<Json | undefined> {
  const v = await usdata.getTabValue(uuid, tabId)
  return v === undefined ? undefined : (v as Json)
}

/** 覆盖写当前标签页对象 */
export async function saveTabValue(uuid: string, tabId: number, value: Json): Promise<void> {
  await usdata.putTabValue(uuid, tabId, value)
}

/** 全部标签页对象快照：键为 tabId 字符串（对齐 GM_getTabs）。仅本脚本自身 */
export async function getAllTabValues(uuid: string): Promise<Record<string, Json>> {
  const all = await usdata.listTabValues(uuid)
  return all as Record<string, Json>
}

/** 删除某 tab 的全部 tab 存储键（tab 关闭清理） */
async function dropTabKeys(tabId: number): Promise<void> {
  await usdata.deleteTabsByTabId(tabId)
}

/** 启动时对账：清掉「记录存在但 tab 已不存在」的孤儿记录（兜浏览器崩溃 / SW 错过 onRemoved） */
async function reconcileOrphanTabKeys(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({})
    const alive = new Set(tabs.map((t) => t.id).filter((id): id is number => id != null))
    await usdata.pruneTabsNotIn(alive)
  } catch {
    // 对账失败不阻断链路
  }
}

/** 挂 tab 生命周期清理（init 时调用一次）：onRemoved 即删 + 冷启动孤儿对账 */
export function mountTabStoreCleanup(): void {
  if (chrome.tabs?.onRemoved?.addListener) {
    chrome.tabs.onRemoved.addListener((tabId) => {
      void dropTabKeys(tabId).catch(() => {})
    })
  }
  void reconcileOrphanTabKeys().catch(() => {})
}
