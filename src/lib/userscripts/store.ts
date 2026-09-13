// 用户脚本持久化（chrome.storage.local 单存储，设计文档 §5）。
//
// 与现有 storage.ts 同风格：直接 chrome.storage.local.get/set，不做额外抽象层。
// 全部脚本记录含源码，键 us:script:<uuid>；GM 值键 us:gm:<uuid>:<key>。
import {
  SCRIPT_KEY_PREFIX,
  GM_KEY_PREFIX,
  scriptKey,
  gmKey,
  type UserScriptMeta,
  type UserScriptSummary,
} from './types'

/** 列出全部脚本记录（含源码）；启用在前、按名称排序，结果稳定 */
export async function listScripts(): Promise<UserScriptMeta[]> {
  const all = await chrome.storage.local.get()
  return Object.entries(all)
    .filter(([k]) => k.startsWith(SCRIPT_KEY_PREFIX))
    .map(([, v]) => v as UserScriptMeta)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
}

/** 列表视图：去掉源码字段，避免一次性把所有脚本源码传给 UI */
export async function listSummaries(): Promise<UserScriptSummary[]> {
  const scripts = await listScripts()
  return scripts.map(({ source, ...rest }) => {
    void source
    return rest
  })
}

export async function getScript(uuid: string): Promise<UserScriptMeta | undefined> {
  const store = await chrome.storage.local.get(scriptKey(uuid))
  return store[scriptKey(uuid)] as UserScriptMeta | undefined
}

export async function saveScript(meta: UserScriptMeta): Promise<void> {
  await chrome.storage.local.set({ [scriptKey(meta.uuid)]: meta })
}

/** 删除脚本记录，并清理其 GM 值（按前缀精确匹配 uuid） */
export async function deleteScript(uuid: string): Promise<void> {
  await chrome.storage.local.remove(scriptKey(uuid))
  const all = await chrome.storage.local.get()
  const prefix = GM_KEY_PREFIX + uuid + ':'
  const gmKeys = Object.keys(all).filter((k) => k.startsWith(prefix))
  if (gmKeys.length) await chrome.storage.local.remove(gmKeys)
}

// —— GM_setValue / GM_getValue 值存储 ——

export async function getGMValue(uuid: string, key: string): Promise<unknown> {
  const store = await chrome.storage.local.get(gmKey(uuid, key))
  return store[gmKey(uuid, key)]
}

export async function setGMValue(uuid: string, key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [gmKey(uuid, key)]: value })
}

export async function deleteGMValue(uuid: string, key: string): Promise<void> {
  await chrome.storage.local.remove(gmKey(uuid, key))
}

/** 列出某脚本存过的全部 GM 键 */
export async function listGMKeys(uuid: string): Promise<string[]> {
  const all = await chrome.storage.local.get()
  const prefix = GM_KEY_PREFIX + uuid + ':'
  return Object.keys(all)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
}
