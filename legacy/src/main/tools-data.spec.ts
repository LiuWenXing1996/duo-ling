import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearToolsData,
  deleteOrphanToolsData,
  getToolsDataDetail,
  isToolsDataCapability,
  listToolsData,
  openToolsDataDir,
  runToolsDataCapability,
  toolsDataRoot,
  toolsDataCapabilities
} from './tools-data'

// 重定向 userData 到临时目录：数据区 <userData>/tools-data 与工具区 <userData>/tools 均在内存/临时盘
const holder = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => holder.userData },
  shell: { openPath: vi.fn() }
}))
vi.mock('./tool-page', () => ({
  toolsRoot: () => join(holder.userData, 'tools')
}))

/** 铺设一个工具目录（index.html + meta.json），用于判定「工具是否存在」 */
function scaffoldTool(id: string, title: string): void {
  const dir = join(holder.userData, 'tools', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<h1>x</h1>', 'utf8')
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, title: title ?? id, description: '' }), 'utf8')
}

describe('tools-data（数据区管理 + tool.data.* 能力）', () => {
  beforeEach(() => {
    holder.userData = mkdtempSync(join(tmpdir(), 'duo-ling-tools-data-'))
  })
  afterEach(() => {
    rmSync(holder.userData, { recursive: true, force: true })
  })

  it('toolsDataRoot：位于 <userData>/tools-data', () => {
    expect(toolsDataRoot()).toBe(join(holder.userData, 'tools-data'))
  })

  it('listToolsData：空数据区返回空列表', () => {
    const res = listToolsData()
    expect(res).toEqual({ ok: true, items: [] })
  })

  it('runToolsDataCapability：write/read/list/remove 全链路读写', () => {
    const toolId = 't1'
    scaffoldTool(toolId, '工具一')

    const write = runToolsDataCapability('tool.data.write', toolId, { key: 'count', value: 3 })
    expect(write.ok).toBe(true)
    if (write.ok) expect(write.result).toMatchObject({ key: 'count' })

    const read = runToolsDataCapability('tool.data.read', toolId, { key: 'count' })
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.result).toMatchObject({ key: 'count', value: 3 })

    const list = runToolsDataCapability('tool.data.list', toolId, {})
    expect(list.ok).toBe(true)
    if (list.ok) expect(list.result).toMatchObject({ keys: ['count'], count: 1 })

    const remove = runToolsDataCapability('tool.data.remove', toolId, { key: 'count' })
    expect(remove.ok).toBe(true)
    const listAfter = runToolsDataCapability('tool.data.list', toolId, {})
    expect(listAfter.ok).toBe(true)
    if (listAfter.ok) expect(listAfter.result).toMatchObject({ count: 0 })
  })

  it('runToolsDataCapability：非法 key 被白名单拒绝（防目录穿越）', () => {
    const toolId = 't1'
    scaffoldTool(toolId, '工具一')
    expect(runToolsDataCapability('tool.data.write', toolId, { key: '../evil', value: 1 }).ok).toBe(false)
    expect(runToolsDataCapability('tool.data.read', toolId, { key: 'a/b' }).ok).toBe(false)
  })

  it('runToolsDataCapability：读取不存在的 key 返回失败', () => {
    const toolId = 't1'
    scaffoldTool(toolId, '工具一')
    const res = runToolsDataCapability('tool.data.read', toolId, { key: 'missing' })
    expect(res.ok).toBe(false)
  })

  it('runToolsDataCapability：未知能力 id 返回错误', () => {
    const res = runToolsDataCapability('tool.data.unknown', 't1', {})
    expect(res.ok).toBe(false)
  })

  it('listToolsData：列出有数据的工具；工具不存在时标记 orphan', () => {
    const kept = 'kept'
    const orphan = 'gone'
    scaffoldTool(kept, '保留工具')
    scaffoldTool(orphan, '孤儿工具')
    runToolsDataCapability('tool.data.write', kept, { key: 'a', value: 1 })
    runToolsDataCapability('tool.data.write', orphan, { key: 'b', value: 2 })

    // 让 orphan 工具「不存在」（删掉其源码目录，只留数据区）
    rmSync(join(holder.userData, 'tools', orphan), { recursive: true, force: true })

    const res = listToolsData()
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const keptItem = res.items.find((i) => i.id === kept)
    const orphanItem = res.items.find((i) => i.id === orphan)
    expect(keptItem).toBeTruthy()
    expect(keptItem?.orphan).toBe(false)
    expect(keptItem?.title).toBe('保留工具')
    expect(orphanItem?.orphan).toBe(true)
  })

  it('getToolsDataDetail：返回每条 key 的大小与时间', () => {
    const toolId = 't1'
    scaffoldTool(toolId, '工具一')
    runToolsDataCapability('tool.data.write', toolId, { key: 'x', value: 'hello' })
    const res = getToolsDataDetail(toolId)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.detail.entries.length).toBe(1)
    expect(res.detail.entries[0].key).toBe('x')
    expect(res.detail.entries[0].size).toBeGreaterThan(0)
    expect(res.detail.title).toBe('工具一')
  })

  it('getToolsDataDetail：不存在的数据区返回失败', () => {
    const res = getToolsDataDetail('nope')
    expect(res.ok).toBe(false)
  })

  it('clearToolsData：移除整个数据目录，幂等', () => {
    const toolId = 't1'
    scaffoldTool(toolId, '工具一')
    runToolsDataCapability('tool.data.write', toolId, { key: 'x', value: 1 })
    expect(existsSync(join(holder.userData, 'tools-data', toolId))).toBe(true)
    expect(clearToolsData(toolId)).toEqual({ ok: true })
    expect(existsSync(join(holder.userData, 'tools-data', toolId))).toBe(false)
    // 再次清除（目录已不存在）仍成功
    expect(clearToolsData(toolId)).toEqual({ ok: true })
  })

  it('deleteOrphanToolsData：仅清理孤儿，保留有主数据', () => {
    const kept = 'kept'
    const orphan = 'gone'
    scaffoldTool(kept, '保留')
    scaffoldTool(orphan, '孤儿')
    runToolsDataCapability('tool.data.write', kept, { key: 'a', value: 1 })
    runToolsDataCapability('tool.data.write', orphan, { key: 'b', value: 2 })
    rmSync(join(holder.userData, 'tools', orphan), { recursive: true, force: true })

    const res = deleteOrphanToolsData()
    expect(res).toEqual({ ok: true, removed: 1 })
    expect(existsSync(join(holder.userData, 'tools-data', kept))).toBe(true)
    expect(existsSync(join(holder.userData, 'tools-data', orphan))).toBe(false)
  })

  it('openToolsDataDir：数据目录不存在时创建再打开', () => {
    const toolId = 't1'
    scaffoldTool(toolId, '工具一')
    const res = openToolsDataDir(toolId)
    expect(res.ok).toBe(true)
    expect(existsSync(join(holder.userData, 'tools-data', toolId))).toBe(true)
  })

  it('isToolsDataCapability：仅匹配 tool.data.*', () => {
    expect(isToolsDataCapability('tool.data.write')).toBe(true)
    expect(isToolsDataCapability('tool.data.xxx')).toBe(true)
    expect(isToolsDataCapability('local.file.read')).toBe(false)
  })

  it('toolsDataCapabilities：四个能力 id 完整且运行时为 backend', () => {
    expect(toolsDataCapabilities.map((c) => c.id)).toEqual([
      'tool.data.write',
      'tool.data.read',
      'tool.data.list',
      'tool.data.remove'
    ])
    expect(toolsDataCapabilities.every((c) => c.runtime === 'backend')).toBe(true)
  })
})
