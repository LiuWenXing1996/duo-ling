import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearPreviewCache,
  commitToolChanges,
  initToolRepo,
  listPreviewCache,
  listToolHistory,
  materializeToolSnapshot,
  rollbackTool
} from './tool-git'

// 重定向 toolsRoot / previewRoot 到临时目录，避免写入真实 userData
const holder = vi.hoisted(() => ({ root: '', previewRoot: '' }))
vi.mock('./tool-page', () => ({
  toolsRoot: () => holder.root,
  previewRoot: () => holder.previewRoot
}))

/** 在 toolsRoot 下铺设一个工具目录（建仓 / 落盘 / commit 都需要目录先存在） */
function scaffoldTool(id: string, title: string, html: string): void {
  const dir = join(holder.root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), html, 'utf8')
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, title, description: '' }), 'utf8')
}

/** 取最新一条提交（listToolHistory 新在前）的 oid */
async function latestOid(id: string): Promise<string> {
  const res = await listToolHistory(id)
  if (!res.ok) throw new Error(res.error)
  return res.commits[0].oid
}

describe('tool-git（isomorphic-git 版本管理）', () => {
  beforeEach(() => {
    holder.root = mkdtempSync(join(tmpdir(), 'duo-ling-tool-git-'))
    holder.previewRoot = mkdtempSync(join(tmpdir(), 'duo-ling-tools-preview-'))
  })
  afterEach(() => {
    rmSync(holder.root, { recursive: true, force: true })
  })

  it('initToolRepo：建仓并做「创建工具」首提，重复调用幂等', async () => {
    const id = 't-init'
    scaffoldTool(id, '初始', '<h1>第一版</h1>')
    const res = await initToolRepo(id)
    expect(res).toEqual({ ok: true, committed: true })
    // 已提交无净变更 → 再次调用不产生新提交
    const again = await initToolRepo(id)
    expect(again).toEqual({ ok: true, committed: false })
  })

  it('commitToolChanges：有净变更才提交，message 用 summary', async () => {
    const id = 't-commit'
    scaffoldTool(id, '初始', '<h1>第一版</h1>')
    await initToolRepo(id)
    const dir = join(holder.root, id)

    // 无改动 → 跳过提交
    const noChange = await commitToolChanges(id, '无改动')
    expect(noChange).toEqual({ ok: true, committed: false })

    // 改动（字节数不同，避免 stat 缓存误判）后提交，message 用 summary
    writeFileSync(join(dir, 'index.html'), '<h1>第二版</h1><p>新增段落</p>', 'utf8')
    const res = await commitToolChanges(id, '改成第二版')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.committed).toBe(true)

    const hist = await listToolHistory(id)
    if (hist.ok) expect(hist.commits[0].message).toBe('改成第二版')
  })

  it('materializeToolSnapshot：把目标 commit 整棵树物化到 <previewRoot>/<id>/<oid>/，幂等复用', async () => {
    const id = 't-mat'
    scaffoldTool(id, '初始', '<h1>第一版</h1>')
    await initToolRepo(id)
    const oid1 = await latestOid(id)
    const dir = join(holder.root, id)

    writeFileSync(join(dir, 'index.html'), '<h1>第二版</h1><p>新增段落</p>', 'utf8')
    const res = await commitToolChanges(id, '改成第二版')
    if (!res.ok) throw new Error(res.error)

    // 物化旧版本 oid1：返回工具预览 URL，落盘到缓存目录
    const mat = await materializeToolSnapshot(id, oid1)
    expect(mat).toEqual({ ok: true, url: `tool-preview://${id}/${oid1}/index.html` })

    const cacheDir = join(holder.previewRoot, id, oid1)
    expect(readFileSync(join(cacheDir, 'index.html'), 'utf8')).toBe('<h1>第一版</h1>')
    // 整棵树（含 meta.json）都被物化，而非仅白名单里的 index.html
    expect(JSON.parse(readFileSync(join(cacheDir, 'meta.json'), 'utf8')).id).toBe(id)

    // 幂等复用：再次物化返回同一 URL，不重复写盘
    const again = await materializeToolSnapshot(id, oid1)
    expect(again).toEqual({ ok: true, url: `tool-preview://${id}/${oid1}/index.html` })

    // 物化不影响工作区当前内容
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('<h1>第二版</h1><p>新增段落</p>')
  })

  it('materializeToolSnapshot：目标仓库不存在时报错', async () => {
    const mat = await materializeToolSnapshot('t-nonexistent', 'a'.repeat(40))
    expect(mat.ok).toBe(false)
    if (!mat.ok) expect(mat.error).toBeTruthy()
  })

  it('listPreviewCache / clearPreviewCache：统计并清空预览缓存区', async () => {
    // 空缓存：不报错
    expect(listPreviewCache()).toEqual({ ok: true, size: 0, versions: 0 })

    const id = 't-cache'
    scaffoldTool(id, '初始', '<h1>第一版</h1>')
    await initToolRepo(id)
    const oid1 = await latestOid(id)
    const dir = join(holder.root, id)
    writeFileSync(join(dir, 'index.html'), '<h1>第二版</h1><p>新增段落</p>', 'utf8')
    const res = await commitToolChanges(id, '改成第二版')
    if (!res.ok || !res.oid) throw new Error(res.ok ? '缺少 oid' : res.error)

    await materializeToolSnapshot(id, oid1)
    await materializeToolSnapshot(id, res.oid)

    const listed = listPreviewCache()
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(listed.versions).toBe(2)
    expect((listed as { ok: true; size: number }).size).toBeGreaterThan(0)
    expect(existsSync(join(holder.previewRoot, id, oid1, 'index.html'))).toBe(true)

    // 清理后整个缓存目录被移除
    expect(clearPreviewCache()).toEqual({ ok: true })
    expect(existsSync(holder.previewRoot)).toBe(false)
  })

  it('rollbackTool：把目标 commit 写回工作区并产生「回滚到 <shortOid>」新提交', async () => {
    const id = 't-rollback'
    scaffoldTool(id, '初始', '<h1>第一版</h1>')
    await initToolRepo(id)
    const oid1 = await latestOid(id)
    const dir = join(holder.root, id)

    writeFileSync(join(dir, 'index.html'), '<h1>第二版</h1><p>新增段落</p>', 'utf8')
    const res = await commitToolChanges(id, '改成第二版')
    if (!res.ok) throw new Error(res.error)

    const rb = await rollbackTool(id, oid1)
    expect(rb.ok).toBe(true)
    if (rb.ok) {
      expect(rb.committed).toBe(true)
      // 工作区文件已回滚到目标版本
      expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('<h1>第一版</h1>')
      // 回滚落一条新提交，message 带上目标提交的原始内容（形如「回滚到 <shortOid>：<原message>」），而不是移动 HEAD
      const hist = await listToolHistory(id)
      if (hist.ok) expect(hist.commits[0].message).toBe(`回滚到 ${oid1.slice(0, 8)}：创建工具`)

      // 再回滚到这条「回滚」提交本身：目标即当前 HEAD → 无净变更 → 跳过提交
      const rb2 = await rollbackTool(id, rb.oid!)
      expect(rb2).toEqual({ ok: true, committed: false })
    }
  })

  it('rollbackTool：目标 commit 不存在时返回错误', async () => {
    const id = 't-rollback-fail'
    scaffoldTool(id, '初始', '<h1>第一版</h1>')
    await initToolRepo(id)
    const rb = await rollbackTool(id, '0000000000000000000000000000000000000000')
    expect(rb.ok).toBe(false)
    if (!rb.ok) expect(rb.error).toBeTruthy()
  })
})
