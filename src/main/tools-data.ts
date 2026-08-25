// 主进程侧：工具数据区管理 + tool.data.* 原子能力实现。
//
// 数据区 <userData>/tools-data/<id>/ 与工具源码 <userData>/tools/<id>/ 天然分离：
//   - manifest.json —— 本工具数据索引入口（id / title / createdAt / updatedAt / entries）
//   - <key>.json     —— 每个 key 一文件，内容为「能力写入的值」的 JSON 序列化
// 删除工具默认「保留数据」；对应工具已不存在时该数据条目标记为孤儿，由设置面板手动清理。
// tool.data.* 能力必须在主进程执行（需 fs + 调用方 toolId），故独立于 backend/frontend 分域收口于此。

import { app, shell } from 'electron'
import fs from 'node:fs'
import { join } from 'node:path'
import type {
  Capability,
  CapabilityRunResponse,
  ToolsDataClearResult,
  ToolsDataDeleteOrphanResult,
  ToolsDataDetail,
  ToolsDataDetailResult,
  ToolsDataEntry,
  ToolsDataListResult,
  ToolsDataOpenResult,
  ToolsDataOverview
} from '../shared/types'
import { toolsRoot } from './tool-page'

/** 数据区根：<userData>/tools-data/<id>/… */
export function toolsDataRoot(): string {
  return join(app.getPath('userData'), 'tools-data')
}

/** key 白名单：仅字母/数字/下划线/连字符，防目录穿越 */
const KEY_RE = /^[A-Za-z0-9_-]+$/

/** 工具 id 合法性：不得含路径分隔符或 `..`（与 tool-page 删除校验一致） */
function validId(id: unknown): id is string {
  return typeof id === 'string' && !!id && !id.includes('..') && !id.includes('/') && !id.includes('\\')
}

function dataDir(id: string): string {
  return join(toolsDataRoot(), id)
}

function manifestPath(id: string): string {
  return join(dataDir(id), 'manifest.json')
}

function keyFile(id: string, key: string): string {
  return join(dataDir(id), `${key}.json`)
}

/** 校验并归一化 key；非法时返回 null */
function normalizeKey(key: unknown): string | null {
  return typeof key === 'string' && KEY_RE.test(key) ? key : null
}

/** 读取 manifest；缺失或损坏返回 null */
function loadManifest(id: string): ToolsDataManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(id), 'utf8')) as Partial<ToolsDataManifest>
    if (typeof raw.id !== 'string') return null
    return {
      id: raw.id,
      title: typeof raw.title === 'string' ? raw.title : '',
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      entries: Array.isArray(raw.entries)
        ? raw.entries.filter(
            (e): e is ToolsDataEntry =>
              !!e && typeof e.key === 'string' && typeof e.size === 'number' && typeof e.updatedAt === 'string'
          )
        : []
    }
  } catch {
    return null
  }
}

function writeManifest(id: string, manifest: ToolsDataManifest): void {
  fs.mkdirSync(dataDir(id), { recursive: true })
  fs.writeFileSync(manifestPath(id), JSON.stringify(manifest, null, 2), 'utf8')
}

/** 从磁盘扫描真实存在的 <key>.json，重建 entries 列表（顺序按 key 字典序） */
function scanDataEntries(id: string): ToolsDataEntry[] {
  const dir = dataDir(id)
  if (!fs.existsSync(dir)) return []
  const entries: ToolsDataEntry[] = []
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!name.isFile() || name.name === 'manifest.json' || !name.name.endsWith('.json')) continue
    const key = name.name.slice(0, -'.json'.length)
    if (!KEY_RE.test(key)) continue
    try {
      const stat = fs.statSync(join(dir, name.name))
      entries.push({ key, size: stat.size, updatedAt: stat.mtime.toISOString() })
    } catch {
      // 单文件 stat 失败则跳过，不阻断整体
    }
  }
  return entries.sort((a, b) => a.key.localeCompare(b.key))
}

/** 汇总条目字节数（供 sizeBytes 展示） */
function sumSize(entries: ToolsDataEntry[]): number {
  return entries.reduce((acc, e) => acc + e.size, 0)
}

/** 该工具是否仍存在（对应 meta.json 存在） */
function toolExists(id: string): boolean {
  return fs.existsSync(join(toolsRoot(), id, 'meta.json'))
}

/** 查询当前工具标题：优先取 meta.json 实况，缺失则回退 manifest 记录，再回退空串 */
function resolveTitle(id: string, manifest: ToolsDataManifest | null): string {
  try {
    const meta = JSON.parse(fs.readFileSync(join(toolsRoot(), id, 'meta.json'), 'utf8')) as {
      title?: string
    }
    if (typeof meta.title === 'string' && meta.title.trim()) return meta.title
  } catch {
    // 工具不存在或 meta 损坏时用 manifest 兜底
  }
  return manifest?.title ?? ''
}

/** 读取某工具的完整 manifest；缺失时用磁盘扫描重建（不写回，避免仅读操作改动磁盘） */
function readOrScanManifest(id: string): ToolsDataManifest | null {
  const dir = dataDir(id)
  if (!fs.existsSync(dir)) return null
  const manifest = loadManifest(id)
  if (manifest) return manifest
  const entries = scanDataEntries(id)
  if (entries.length === 0) return null
  return {
    id,
    title: '',
    createdAt: '',
    updatedAt: entries.reduce((m, e) => (e.updatedAt > m ? e.updatedAt : m), ''),
    entries
  }
}

// —— IPC 供设置面板 / 详情页调用 ——

/** 遍历数据区所有工目录，构造概览列表（按 updatedAt 倒序，最近写入在前） */
export function listToolsData(): ToolsDataListResult {
  try {
    const root = toolsDataRoot()
    if (!fs.existsSync(root)) return { ok: true, items: [] }
    const items: ToolsDataOverview[] = []
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const id = entry.name
      if (!validId(id)) continue
      const manifest = readOrScanManifest(id)
      if (!manifest) continue
      const entries = manifest.entries
      items.push({
        id,
        title: resolveTitle(id, manifest),
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        sizeBytes: sumSize(entries),
        keyCount: entries.length,
        orphan: !toolExists(id)
      })
    }
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return { ok: true, items }
  } catch (error) {
    return { ok: false, error: toError(error) }
  }
}

/** 读取某工具的数据详情（含每个 key 的条目） */
export function getToolsDataDetail(id: string): ToolsDataDetailResult {
  if (!validId(id)) return { ok: false, error: '非法工具 id' }
  try {
    const manifest = readOrScanManifest(id)
    if (!manifest) return { ok: false, error: '工具数据不存在' }
    const detail: ToolsDataDetail = {
      id: id,
      title: resolveTitle(id, manifest),
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      sizeBytes: sumSize(manifest.entries),
      entries: manifest.entries
    }
    return { ok: true, detail }
  } catch (error) {
    return { ok: false, error: toError(error) }
  }
}

/** 清空某工具全部数据：移除数据目录（幂等：不存在也视为成功） */
export function clearToolsData(id: string): ToolsDataClearResult {
  if (!validId(id)) return { ok: false, error: '非法工具 id' }
  try {
    fs.rmSync(dataDir(id), { recursive: true, force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: toError(error) }
  }
}

/** 清理孤儿数据：删除所有对应工具已不存在的数据目录，返回移除个数 */
export function deleteOrphanToolsData(): ToolsDataDeleteOrphanResult {
  try {
    const root = toolsDataRoot()
    if (!fs.existsSync(root)) return { ok: true, removed: 0 }
    let removed = 0
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const id = entry.name
      if (!validId(id)) continue
      if (!toolExists(id)) {
        fs.rmSync(dataDir(id), { recursive: true, force: true })
        removed += 1
      }
    }
    return { ok: true, removed }
  } catch (error) {
    return { ok: false, error: toError(error) }
  }
}

/** 在系统文件管理器中打开某工具数据目录 */
export function openToolsDataDir(id: string): ToolsDataOpenResult {
  if (!validId(id)) return { ok: false, error: '非法工具 id' }
  try {
    const dir = dataDir(id)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    shell.openPath(dir)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: toError(error) }
  }
}

// —— tool.data.* 原子能力 ——

interface ToolsDataManifest {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  entries: ToolsDataEntry[]
}

/** 新建一个不带 entries 的 manifest 骨架（能力写入时若缺失则据此初始化） */
function emptyManifest(id: string): ToolsDataManifest {
  const now = new Date().toISOString()
  return { id, title: '', createdAt: now, updatedAt: now, entries: [] }
}

/**
 * 执行 tool.data.* 能力。toolId 由 capability:run 路由时从调用方 URL 解析得出；
 * 提供 write / read / list / remove 四类操作，全部落到 <userData>/tools-data/<toolId>/ 下。
 */
export function runToolsDataCapability(
  capId: string,
  toolId: string,
  args: unknown
): CapabilityRunResponse {
  if (!validId(toolId)) return { ok: false, error: '非法工具来源' }
  const tool = toolId

  try {
    switch (capId) {
      case 'tool.data.write': {
        const { key, value } = (args ?? {}) as { key?: unknown; value?: unknown }
        const k = normalizeKey(key)
        if (!k) return { ok: false, error: 'key 非法：仅允许字母/数字/下划线/连字符' }
        const content = JSON.stringify(value === undefined ? null : value, null, 2)
        fs.mkdirSync(dataDir(tool), { recursive: true })
        fs.writeFileSync(keyFile(tool, k), content, 'utf8')
        const now = new Date().toISOString()
        const manifest = loadManifest(tool) ?? emptyManifest(tool)
        const entry = manifest.entries.find((e) => e.key === k)
        if (entry) {
          entry.size = Buffer.byteLength(content, 'utf8')
          entry.updatedAt = now
        } else {
          manifest.entries.push({ key: k, size: Buffer.byteLength(content, 'utf8'), updatedAt: now })
        }
        manifest.updatedAt = now
        writeManifest(tool, manifest)
        return { ok: true, result: { key: k, size: Buffer.byteLength(content, 'utf8'), updatedAt: now } }
      }

      case 'tool.data.read': {
        const { key } = (args ?? {}) as { key?: unknown }
        const k = normalizeKey(key)
        if (!k) return { ok: false, error: 'key 非法：仅允许字母/数字/下划线/连字符' }
        const file = keyFile(tool, k)
        if (!fs.existsSync(file)) return { ok: false, error: `key 不存在: ${k}` }
        return { ok: true, result: { key: k, value: JSON.parse(fs.readFileSync(file, 'utf8')) } }
      }

      case 'tool.data.list': {
        const manifest = loadManifest(tool)
        const keys = manifest?.entries ? [...manifest.entries].sort((a, b) => a.key.localeCompare(b.key)) : []
        return {
          ok: true,
          result: { keys: keys.map((e) => e.key), count: keys.length, sizeBytes: sumSize(keys) }
        }
      }

      case 'tool.data.remove': {
        const { key } = (args ?? {}) as { key?: unknown }
        const k = normalizeKey(key)
        if (!k) return { ok: false, error: 'key 非法：仅允许字母/数字/下划线/连字符' }
        const file = keyFile(tool, k)
        if (!fs.existsSync(file)) return { ok: false, error: `key 不存在: ${k}` }
        fs.rmSync(file, { force: true })
        const manifest = loadManifest(tool)
        if (manifest) {
          manifest.entries = manifest.entries.filter((e) => e.key !== k)
          manifest.updatedAt = new Date().toISOString()
          writeManifest(tool, manifest)
        }
        return { ok: true, result: { key: k, removed: true } }
      }

      default:
        return { ok: false, error: `未知工具数据能力: ${capId}` }
    }
  } catch (error) {
    return { ok: false, error: toError(error) }
  }
}

/** tool.data.* 能力清单（供 capability:list 返回生成器可读全集） */
export const toolsDataCapabilities: Capability[] = [
  {
    id: 'tool.data.write',
    name: '工具数据写入',
    description: '为当前工具持久化一个键值对，写入工具数据区（key 白名单为字母/数字/下划线/连字符）',
    inputSchema: {
      type: 'object',
      description: '写入参数',
      fields: {
        key: { type: 'string', description: '数据键，仅字母/数字/下划线/连字符' },
        value: { type: 'any', description: '要持久化的任意 JSON 值' }
      }
    },
    outputSchema: {
      type: 'object',
      description: '写入结果',
      fields: { key: { type: 'string', description: '已写入的数据键' }, size: { type: 'number', description: '文件字节数' } }
    },
    sideEffect: 'write',
    runtime: 'backend',
    cost: 'offline',
    scenario: { keywords: ['保存', '写入', '数据', '持久化', 'json'], object: '当前工具数据' }
  },
  {
    id: 'tool.data.read',
    name: '工具数据读取',
    description: '读取当前工具此前持久化的某个键值对',
    inputSchema: {
      type: 'object',
      description: '读取参数',
      fields: { key: { type: 'string', description: '要读取的数据键' } }
    },
    outputSchema: {
      type: 'object',
      description: '读取结果',
      fields: { key: { type: 'string', description: '数据键' }, value: { type: 'any', description: '持久化的值' } }
    },
    sideEffect: 'read',
    runtime: 'backend',
    cost: 'offline',
    scenario: { keywords: ['读取', '数据', '取值', 'json'], object: '当前工具数据' }
  },
  {
    id: 'tool.data.list',
    name: '工具数据列表',
    description: '列出当前工具已持久化的所有数据键',
    inputSchema: { type: 'object', description: '无参数' },
    outputSchema: {
      type: 'object',
      description: '列表结果',
      fields: { keys: { type: 'array', description: '数据键列表' }, count: { type: 'number', description: '键个数' } }
    },
    sideEffect: 'read',
    runtime: 'backend',
    cost: 'offline',
    scenario: { keywords: ['列表', '数据', 'keys'], object: '当前工具数据' }
  },
  {
    id: 'tool.data.remove',
    name: '工具数据删除',
    description: '删除当前工具此前持久化的某个数据键',
    inputSchema: {
      type: 'object',
      description: '删除参数',
      fields: { key: { type: 'string', description: '要删除的数据键' } }
    },
    outputSchema: {
      type: 'object',
      description: '删除结果',
      fields: { key: { type: 'string', description: '已删除的数据键' }, removed: { type: 'boolean', description: '是否删除成功' } }
    },
    sideEffect: 'destructive',
    runtime: 'backend',
    cost: 'offline',
    scenario: { keywords: ['删除', '数据', '清除', 'remove'], object: '当前工具数据' }
  }
]

/** tool.data.* 能力是否属于工具数据运行域 */
export function isToolsDataCapability(capId: string): boolean {
  return capId.startsWith('tool.data.')
}

function toError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
