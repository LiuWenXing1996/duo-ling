// 工具数据管理（设置面板「工具数据」表格 + 工具详情页的「数据」标签页）。
//
// 桌面版：工具数据是 <userData>/tools-data/<id>/*.json，由主进程按目录统计。
// 扩展版：工具数据落在 chrome.storage.local 的 <toolId> 键下（见 src/lib/storage.ts），
// 因此这里按 storage 键统计，并把「对应工具已不存在」的键判为孤儿数据（等价于桌面版的 meta.json 缺失）。
//
// 时间戳：storage 本身不记录创建/更新时间，故由写入方（setToolData）在 TOOL_DATA_META_KEY 里补登，
// 未登记过的历史数据回退为空串 —— 宁可为空，也不要编一个看起来像真的时间。
import { RESERVED_STORAGE_KEYS } from './tool-prefs'
import type {
  ToolsDataClearResult,
  ToolsDataDeleteOrphanResult,
  ToolsDataDetail,
  ToolsDataDetailResult,
  ToolsDataEntry,
  ToolsDataListResult,
  ToolsDataOverview,
} from '../shared/types'

const TOOL_DATA_META_KEY = 'toolDataMeta'

/** 保留键：工具数据区之外的扩展自用键，任何「按 id 操作」的入口都必须拒绝 */
function isReservedKey(key: string): boolean {
  return (RESERVED_STORAGE_KEYS as readonly string[]).includes(key) || key === TOOL_DATA_META_KEY
}

interface ToolDataMeta {
  createdAt?: string
  updatedAt?: string
}

async function readMetaMap(): Promise<Record<string, ToolDataMeta>> {
  const raw = (await chrome.storage.local.get(TOOL_DATA_META_KEY))[TOOL_DATA_META_KEY]
  return raw && typeof raw === 'object' ? (raw as Record<string, ToolDataMeta>) : {}
}

async function writeMeta(toolId: string): Promise<void> {
  const map = await readMetaMap()
  const now = new Date().toISOString()
  const prev = map[toolId]
  map[toolId] = { createdAt: prev?.createdAt ?? now, updatedAt: now }
  await chrome.storage.local.set({ [TOOL_DATA_META_KEY]: map })
}

/** 记录一次工具数据写入：供 storage.setToolData 调用，维持数据区的时间戳 */
export async function touchToolData(toolId: string): Promise<void> {
  await writeMeta(toolId)
}

function byteSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length
  } catch {
    return 0
  }
}

function entriesOf(data: Record<string, unknown>): ToolsDataEntry[] {
  return Object.keys(data).map((key) => ({
    key,
    size: byteSize(data[key]),
    updatedAt: '',
  }))
}

/** 枚举全部工具数据区：排除保留键（模型配置、置顶/分组偏好等） */
async function collect(): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const all = await chrome.storage.local.get(null)
  return Object.entries(all)
    .filter(([key]) => !isReservedKey(key))
    .filter(([, value]) => value !== null && typeof value === 'object')
    .map(([id, value]) => ({ id, data: value as Record<string, unknown> }))
}

export async function listToolsData(toolIds: string[]): Promise<ToolsDataListResult> {
  try {
    const meta = await readMetaMap()
    const items: ToolsDataOverview[] = []
    for (const { id, data } of await collect()) {
      const keys = Object.keys(data)
      if (!keys.length) continue
      items.push({
        id,
        title: toolIds.includes(id) ? id : '',
        createdAt: meta[id]?.createdAt ?? '',
        updatedAt: meta[id]?.updatedAt ?? '',
        sizeBytes: byteSize(data),
        keyCount: keys.length,
        orphan: !toolIds.includes(id),
      })
    }
    return { ok: true, items }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function getToolsDataDetail(
  toolId: string,
  toolIds: string[],
): Promise<ToolsDataDetailResult> {
  // 对应桌面版的 validId 校验：保留键承载的是扩展自身配置（模型、置顶、分组），
  // 不是工具数据区，误删会让配置一起消失。
  if (!toolId || isReservedKey(toolId)) return { ok: false, error: '非法工具 id' }
  try {
    const data = (await chrome.storage.local.get(toolId))[toolId] as Record<string, unknown> | undefined
    if (!data) {
      return { ok: false, error: `工具 ${toolId} 暂无数据` }
    }
    const meta = (await readMetaMap())[toolId]
    const detail: ToolsDataDetail = {
      id: toolId,
      title: toolIds.includes(toolId) ? toolId : '',
      createdAt: meta?.createdAt ?? '',
      updatedAt: meta?.updatedAt ?? '',
      sizeBytes: byteSize(data),
      entries: entriesOf(data),
    }
    return { ok: true, detail }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function clearToolsData(toolId: string): Promise<ToolsDataClearResult> {
  if (!toolId || isReservedKey(toolId)) return { ok: false, error: '非法工具 id' }
  try {
    await chrome.storage.local.remove(toolId)
    const map = await readMetaMap()
    delete map[toolId]
    await chrome.storage.local.set({ [TOOL_DATA_META_KEY]: map })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function deleteOrphanToolsData(toolIds: string[]): Promise<ToolsDataDeleteOrphanResult> {
  try {
    const orphans = (await collect()).filter(({ id }) => !toolIds.includes(id))
    if (orphans.length) await chrome.storage.local.remove(orphans.map((o) => o.id))
    return { ok: true, removed: orphans.length }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
