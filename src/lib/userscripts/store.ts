// 用户脚本持久化（chrome.storage.local 单存储，v2 方案 docs/userscript-v2-plan.md）。
//
// 脚本记录：键 us:script:<uuid>，值为 ScriptProject（v:1）或旧 GM 形态记录（已弃用）。
// DL.store 值：键 us:gm:<uuid>:<key>（键空间沿用旧 GM 键名，v2 决策不改名）。
import {
  SCRIPT_KEY_PREFIX,
  GM_KEY_PREFIX,
  ERRORS_KEY,
  scriptKey,
  gmKey,
  isLegacyScriptRecord,
  type ScriptProject,
  type ScriptSummary,
  type UserScriptErrorRecord,
  type UserScriptMeta,
} from './types'

/** 列出全部新形态项目（含源码）；启用在前、按名称排序，结果稳定。旧 GM 记录不在此列 */
export async function listProjects(): Promise<ScriptProject[]> {
  const all = await chrome.storage.local.get()
  return Object.entries(all)
    .filter(([k]) => k.startsWith(SCRIPT_KEY_PREFIX))
    .map(([, v]) => v as ScriptProject)
    .filter((p) => p?.v === 1 && typeof p.files === 'object')
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
}

/** 列出全部旧 GM 形态记录（已弃用：不注册，仅供列表展示与清理） */
export async function listLegacyScripts(): Promise<UserScriptMeta[]> {
  const all = await chrome.storage.local.get()
  return Object.entries(all)
    .filter(([k]) => k.startsWith(SCRIPT_KEY_PREFIX))
    .map(([, v]) => v)
    .filter(isLegacyScriptRecord)
}

/** 列表视图：项目 + 已弃用旧记录（不含源码与构建产物），未弃用在前、启用在前 */
export async function listSummaries(): Promise<ScriptSummary[]> {
  const [projects, legacy] = await Promise.all([listProjects(), listLegacyScripts()])
  const projectSummaries: ScriptSummary[] = projects.map((p) => ({
    uuid: p.uuid,
    name: p.name,
    enabled: p.enabled,
    matches: p.config.matches ?? [],
    deprecated: false,
    fileCount: Object.keys(p.files).length,
    updatedAt: p.updatedAt,
  }))
  const legacySummaries: ScriptSummary[] = legacy.map((m) => ({
    uuid: m.uuid,
    name: m.name,
    enabled: false, // 旧记录一律不注册
    matches: m.matches ?? [],
    deprecated: true,
    fileCount: 0,
    updatedAt: 0,
  }))
  return [...projectSummaries, ...legacySummaries].sort(
    (a, b) =>
      Number(a.deprecated) - Number(b.deprecated) ||
      Number(b.enabled) - Number(a.enabled) ||
      a.name.localeCompare(b.name),
  )
}

export async function getProject(uuid: string): Promise<ScriptProject | undefined> {
  const store = await chrome.storage.local.get(scriptKey(uuid))
  const v = store[scriptKey(uuid)] as ScriptProject | undefined
  return v?.v === 1 ? v : undefined
}

/** 读旧 GM 形态记录（deprecated 展示用） */
export async function getLegacyScript(uuid: string): Promise<UserScriptMeta | undefined> {
  const store = await chrome.storage.local.get(scriptKey(uuid))
  const v = store[scriptKey(uuid)]
  return isLegacyScriptRecord(v) ? v : undefined
}

export async function saveProject(project: ScriptProject): Promise<void> {
  await chrome.storage.local.set({ [scriptKey(project.uuid)]: project })
}

/** 删除脚本记录（新/旧形态通用），并清理其 DL.store 值（按前缀精确匹配 uuid） */
export async function deleteScript(uuid: string): Promise<void> {
  await chrome.storage.local.remove(scriptKey(uuid))
  await clearGMValues(uuid)
}

// —— 文件树操作（Phase 1：多文件项目）——

/**
 * 文件树校验（保存前调用，非法直接抛错）：
 * 非空、路径相对（禁开头 / 与 .. 段，防越权写）、内容必须是字符串、entry 必须存在。
 */
export function validateFiles(files: Record<string, string>, entry: string): void {
  if (!files || typeof files !== 'object' || !Object.keys(files).length) {
    throw new Error('文件树不能为空')
  }
  for (const p of Object.keys(files)) {
    if (!p || p.startsWith('/') || p.split('/').includes('..')) {
      throw new Error(`非法文件路径（须为相对路径，且不含 .. 段）：${p}`)
    }
    if (p.endsWith('/')) {
      throw new Error(`非法文件路径（不能以 / 结尾）：${p}`)
    }
    if (typeof files[p] !== 'string') {
      throw new Error(`文件内容必须是字符串：${p}`)
    }
  }
  if (!(entry in files)) {
    throw new Error(`入口文件在文件树中不存在：${entry}`)
  }
}

/** 更新项目文件树与入口（校验后整体替换 files，回写 updatedAt），返回更新后的项目 */
export async function updateProjectFiles(
  uuid: string,
  files: Record<string, string>,
  entry: string,
): Promise<ScriptProject> {
  const project = await getProject(uuid)
  if (!project) throw new Error('脚本不存在或为已弃用旧记录')
  validateFiles(files, entry)
  project.files = files
  project.entry = entry
  project.updatedAt = Date.now()
  await saveProject(project)
  return project
}

/** 一键清理全部旧 GM 形态记录（含各自的 DL.store 值），返回清理条数 */
export async function clearDeprecatedScripts(): Promise<number> {
  const legacy = await listLegacyScripts()
  for (const m of legacy) {
    await deleteScript(m.uuid)
  }
  return legacy.length
}

// —— DL.store 值存储（键空间 us:gm:<uuid>:<key> 沿用）——

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

/** 列出某脚本存过的全部键 */
export async function listGMKeys(uuid: string): Promise<string[]> {
  const all = await chrome.storage.local.get()
  const prefix = GM_KEY_PREFIX + uuid + ':'
  return Object.keys(all)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
}

/** 清空某脚本的全部 DL.store 值 */
export async function clearGMValues(uuid: string): Promise<void> {
  const all = await chrome.storage.local.get()
  const prefix = GM_KEY_PREFIX + uuid + ':'
  const keys = Object.keys(all).filter((k) => k.startsWith(prefix))
  if (keys.length) await chrome.storage.local.remove(keys)
}

// —— 错误日志（错误面板）——
//
// 运行期错误经 DL 包装转发到 onUserScriptMessage 后被收集；注册/桥失败在后台直接收集。
// 环形保留最近 N 条，避免无限增长。

const MAX_ERRORS = 50

/** 追加一条错误（自动补 id；time 缺省用当前时间） */
export async function appendUserScriptError(
  // time 由本函数兜底（rec.time || Date.now()），故对调用方可选
  rec: Omit<UserScriptErrorRecord, 'id' | 'time'> & { id?: string; time?: number },
): Promise<void> {
  const existing = ((await chrome.storage.local.get(ERRORS_KEY))[ERRORS_KEY] as UserScriptErrorRecord[] | undefined) ?? []
  const next = existing.slice(-(MAX_ERRORS - 1))
  next.push({ ...rec, id: rec.id || crypto.randomUUID(), time: rec.time || Date.now() })
  await chrome.storage.local.set({ [ERRORS_KEY]: next })
}

/** 列出全部错误（最新在前） */
export async function listUserScriptErrors(): Promise<UserScriptErrorRecord[]> {
  const r = (await chrome.storage.local.get(ERRORS_KEY))[ERRORS_KEY] as UserScriptErrorRecord[] | undefined
  return (r ?? []).slice().reverse()
}

/** 清空错误日志 */
export async function clearUserScriptErrors(): Promise<void> {
  await chrome.storage.local.remove(ERRORS_KEY)
}
