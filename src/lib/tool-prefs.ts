// 工具的用户级偏好：置顶与分组。
//
// 桌面版由主进程落在 userData 下的 JSON（tool-pin-store / tool-group-store），并且刻意不写进 meta.json
// —— 这两项是「用户的整理习惯」，与工具自身的元信息分开存放。扩展版没有独立配置文件，
// 改用 chrome.storage.local 的两个保留键，语义与桌面版一致：
//   · 置顶：追加到末尾 / 取消则移除，写操作返回更新后的全量 id 列表（按置顶顺序）
//   · 分组：toolId → 分组名，传空串表示移除分组，写操作返回更新后的全量映射
const PIN_KEY = 'toolPrefs.pins'
const GROUP_KEY = 'toolPrefs.groups'

/**
 * chrome.storage.local 里被扩展自身占用的保留键：枚举「工具数据区」时必须排除，
 * 任何以工具 id 为入参的读写入口（storage.setToolData / toolsData.clear 等）也必须拒绝，
 * 否则会误伤模型配置、会话序号这类扩展配置。新增自用键时请登记到这里。
 */
export const RESERVED_STORAGE_KEYS = [
  PIN_KEY,
  GROUP_KEY,
  'modelProfiles',
  'toolDataMeta',
  'conversationSeq',
] as const

export type ToolGroupMap = Record<string, string>

export async function listPinnedToolIds(): Promise<string[]> {
  const raw = (await chrome.storage.local.get(PIN_KEY))[PIN_KEY]
  return Array.isArray(raw) ? (raw as string[]) : []
}

export async function setToolPinned(toolId: string, pinned: boolean): Promise<string[]> {
  const current = await listPinnedToolIds()
  const next = pinned
    ? current.includes(toolId)
      ? current
      : [...current, toolId]
    : current.filter((id) => id !== toolId)
  await chrome.storage.local.set({ [PIN_KEY]: next })
  return next
}

export async function clearToolPin(toolId: string): Promise<void> {
  await setToolPinned(toolId, false)
}

export async function getToolGroupMap(): Promise<ToolGroupMap> {
  const raw = (await chrome.storage.local.get(GROUP_KEY))[GROUP_KEY]
  return raw && typeof raw === 'object' ? (raw as ToolGroupMap) : {}
}

export async function setToolGroup(toolId: string, group: string): Promise<ToolGroupMap> {
  const next = { ...(await getToolGroupMap()) }
  const name = group.trim()
  if (name) next[toolId] = name
  else delete next[toolId]
  await chrome.storage.local.set({ [GROUP_KEY]: next })
  return next
}

export async function clearToolGroup(toolId: string): Promise<void> {
  await setToolGroup(toolId, '')
}
