// project-write.ts 单测（offscreen 写侧）：测试直调写 API，通过 mock builder（esbuild-wasm）
// 与 us-git（lightning-fs）模拟 offscreen 上下文——这两个模块在真实环境里分别依赖
// chrome.runtime.getURL 拉起的 wasm 与 lightning-fs，均非层1靶心。
// 被测重点是写侧自身的语义：bundle 必要条件（新建/保存路径）、守卫校验、快照失败不阻断、
// 启停不产生提交，以及 zip 导入「尽量导入」语义（2026-09-17 修订：非原则项不淘汰）。
import 'fake-indexeddb/auto'
import { strToU8, zipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./builder', () => {
  class BuildError extends Error {
    issues: string[]
    constructor(issues: string[]) {
      super(issues[0] ?? '构建失败')
      this.name = 'BuildError'
      this.issues = issues
    }
  }
  return {
    BuildError,
    buildProject: vi.fn(async (files: Record<string, string>) => ({
      code: `//bundled(${Object.keys(files).length})`,
      files,
      remoteFetched: [],
    })),
  }
})

vi.mock('./us-git', () => ({
  snapshotProject: vi.fn(async () => {}),
  deleteRepo: vi.fn(async () => {}),
}))

import { buildProject } from './builder'
import {
  createProject,
  importScriptsZip,
  removeProjectAndRepo,
  setProjectEnabled,
  updateProjectFiles,
} from './project-write'
import { readAllProjects, removeProjects } from './state-db'
import { bytesToBase64 } from './zip-transfer'
import { deleteRepo, snapshotProject } from './us-git'
import type { ScriptProject } from './types'

const mockSnapshot = vi.mocked(snapshotProject)
const mockDeleteRepo = vi.mocked(deleteRepo)
const mockBuild = vi.mocked(buildProject)

function validFiles(): Record<string, string> {
  return { 'main.js': 'console.log(1)' }
}

const VALID_BUNDLE = { code: '//b', builtAt: 1 }

beforeEach(async () => {
  vi.clearAllMocks()
  mockSnapshot.mockResolvedValue({ committed: true })
  mockDeleteRepo.mockResolvedValue(undefined)
  mockBuild.mockClear()
  const all = await readAllProjects()
  await removeProjects(all.map((p) => p.uuid))
})

describe('createProject', () => {
  it('零输入创建：自动命名 / 新建即启用 / 默认配置与入口 / 先构建出产物', async () => {
    const p = await createProject()
    expect(p.name).toBe('新建的脚本 1')
    expect(p.enabled).toBe(true)
    expect(p.entry).toBe('main.js')
    expect(p.config).toEqual({ matches: ['*://*/*'], allFrames: true, runAt: 'document_end' })
    expect(p.files['main.js']).toBeTruthy()
    expect(p.bundle).toBeDefined()
    expect(p.bundle!.code).toContain('bundled')
    expect(mockBuild).toHaveBeenCalledOnce()
  })

  it('连续创建不重名（1 → 2）', async () => {
    await createProject()
    const second = await createProject()
    expect(second.name).toBe('新建的脚本 2')
  })

  it('落盘 + 快照提交（首次即建仓）', async () => {
    const p = await createProject()
    await expect(readAllProjects()).resolves.toHaveLength(1)
    expect(mockSnapshot).toHaveBeenCalledOnce()
    const [projArg, noteArg] = mockSnapshot.mock.calls[0]
    expect((projArg as ScriptProject).uuid).toBe(p.uuid)
    expect(noteArg).toBeUndefined()
  })

  it('构建失败即创建失败，且不落盘', async () => {
    mockBuild.mockRejectedValueOnce(
      new (await import('./builder')).BuildError(['main.js:1:1 语法错误']),
    )
    await expect(createProject()).rejects.toThrow('构建失败：')
    await expect(readAllProjects()).resolves.toEqual([])
  })
})

describe('updateProjectFiles', () => {
  it('脚本不存在抛错', async () => {
    await expect(
      updateProjectFiles('ghost', validFiles(), 'main.js', VALID_BUNDLE),
    ).rejects.toThrow('脚本不存在')
  })

  it('文件树校验失败抛错且不写', async () => {
    const p = await createProject()
    await expect(
      updateProjectFiles(p.uuid, {}, 'main.js', VALID_BUNDLE),
    ).rejects.toThrow('文件树不能为空')
    const after = await readAllProjects()
    expect(after[0].files).toEqual(p.files)
  })

  it('更新文件 / 产物 / updatedAt，并快照提交带 note', async () => {
    const p = await createProject()
    mockSnapshot.mockClear()
    const next = await updateProjectFiles(
      p.uuid,
      { 'main.js': '// v2', 'lib/a.js': 'x' },
      'main.js',
      { code: '//c2', builtAt: 999 },
      { name: '  改名  ', note: '第一次保存' },
    )
    expect(next.name).toBe('改名') // 名称去空白
    expect(next.files).toEqual({ 'main.js': '// v2', 'lib/a.js': 'x' })
    expect(next.bundle).toEqual({ code: '//c2', builtAt: 999 })
    expect(next.updatedAt).toBeGreaterThanOrEqual(p.updatedAt)
    expect(mockSnapshot).toHaveBeenCalledOnce()
    expect(mockSnapshot.mock.calls[0][1]).toBe('第一次保存')
  })

  it('名称全空白抛错', async () => {
    const p = await createProject()
    await expect(
      updateProjectFiles(p.uuid, validFiles(), 'main.js', VALID_BUNDLE, { name: '   ' }),
    ).rejects.toThrow('脚本名称不能为空')
  })

  it('config.matches 为空抛错', async () => {
    const p = await createProject()
    await expect(
      updateProjectFiles(p.uuid, validFiles(), 'main.js', VALID_BUNDLE, {
        config: { matches: [], allFrames: true, runAt: 'document_end' },
      }),
    ).rejects.toThrow('匹配规则（matches）至少一条')
  })

  it('不传 name / config 时保持原值', async () => {
    const p = await createProject()
    const next = await updateProjectFiles(p.uuid, validFiles(), 'main.js', VALID_BUNDLE)
    expect(next.name).toBe(p.name)
    expect(next.config).toEqual(p.config)
  })
})

describe('setProjectEnabled', () => {
  it('只改 enabled，不产生快照提交', async () => {
    const p = await createProject()
    mockSnapshot.mockClear()
    const next = await setProjectEnabled(p.uuid, false)
    expect(next.enabled).toBe(false)
    expect(mockSnapshot).not.toHaveBeenCalled()
    const stored = (await readAllProjects()).find((x) => x.uuid === p.uuid)
    expect(stored?.enabled).toBe(false)
  })

  it('脚本不存在抛错', async () => {
    await expect(setProjectEnabled('ghost', true)).rejects.toThrow('脚本不存在')
  })
})

describe('removeProjectAndRepo', () => {
  it('状态记录与 git 仓一起清', async () => {
    const p = await createProject()
    await removeProjectAndRepo(p.uuid)
    await expect(readAllProjects()).resolves.toEqual([])
    expect(mockDeleteRepo).toHaveBeenCalledOnce()
    expect(mockDeleteRepo.mock.calls[0][0]).toBe(p.uuid)
  })

  it('仓删除失败不影响记录删除（只 warn 不抛）', async () => {
    const p = await createProject()
    mockDeleteRepo.mockRejectedValueOnce(new Error('fs 坏了'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(removeProjectAndRepo(p.uuid)).resolves.toBeUndefined()
    await expect(readAllProjects()).resolves.toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe('快照失败策略', () => {
  it('updateProjectFiles：快照失败只 warn，状态照常落盘（commit 失败只丢历史不丢脚本）', async () => {
    const p = await createProject()
    mockSnapshot.mockClear()
    mockSnapshot.mockRejectedValueOnce(new Error('git 崩了'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      updateProjectFiles(p.uuid, validFiles(), 'main.js', VALID_BUNDLE),
    ).resolves.toMatchObject({ files: validFiles() })
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

// —— zip 导入（docs/userscript-zip-transfer.md §5；提案决策：保留原名 / enabled false / 单写方落盘）——

/** 构造一个 zip 的 base64：scripts 为顶层目录 → files 映射 */
function makeZipBase64(
  scripts: Array<{
    dir: string
    name: string
    files: Record<string, string>
    matches?: string[]
    v?: number
    entry?: string
  }>,
): string {
  const entries: Record<string, Uint8Array> = {}
  for (const s of scripts) {
    entries[`${s.dir}/project.json`] = strToU8(
      JSON.stringify({
        v: s.v ?? 1,
        name: s.name,
        config: { matches: s.matches ?? ['*://*/*'], allFrames: true, runAt: 'document_end' },
        entry: s.entry ?? 'main.js',
        exportedAt: 1726000000000,
      }),
    )
    for (const [p, content] of Object.entries(s.files)) {
      entries[`${s.dir}/files/${p}`] = strToU8(content)
    }
  }
  return bytesToBase64(zipSync(entries))
}

describe('importScriptsZip', () => {
  it('单脚本导入成功：enabled 恒 false / uuid 重生成 / 快照 note = 「从 zip 导入」/ 保留原名', async () => {
    const report = await importScriptsZip(
      makeZipBase64([{ dir: 'demo', name: '演示脚本', files: { 'main.js': 'console.log(1)' } }]),
    )
    expect(report.succeeded).toBe(1)
    expect(report.failed).toBe(0)
    const item = report.results[0]!
    expect(item.status).toBe('ok')
    const stored = (await readAllProjects()).find((p) => p.uuid === (item as { uuid: string }).uuid)
    expect(stored).toBeDefined()
    expect(stored!.enabled).toBe(false)
    expect(stored!.name).toBe('演示脚本')
    expect(stored!.bundle).toBeDefined() // 先构建后落盘（产物不变量）
    expect(mockSnapshot).toHaveBeenCalledOnce()
    expect(mockSnapshot.mock.calls[0]![1]).toBe('从 zip 导入')
  })

  it('重复导入同一内容：仍导入为独立副本，报告带 duplicateOf 提示（定稿 §5.6）', async () => {
    const zip = makeZipBase64([{ dir: 'demo', name: '演示', files: { 'main.js': 'console.log(1)' } }])
    const first = await importScriptsZip(zip)
    expect(first.results[0]).toMatchObject({ status: 'ok' })
    expect(first.results[0]).not.toHaveProperty('duplicateOf')
    const second = await importScriptsZip(zip)
    expect(second.succeeded).toBe(1)
    expect(second.results[0]).toMatchObject({ status: 'ok', duplicateOf: '演示' })
    await expect(readAllProjects()).resolves.toHaveLength(2)
  })

  it('构建失败不淘汰：脚本仍导入（bundle 缺省）+ note 带 esbuild 诊断', async () => {
    mockBuild.mockRejectedValueOnce(new (await import('./builder')).BuildError(['main.js:1:1 语法错误']))
    const report = await importScriptsZip(
      makeZipBase64([
        { dir: 'bad', name: '坏脚本', files: { 'main.js': 'syntax error here' } },
        { dir: 'good', name: '好脚本', files: { 'main.js': 'console.log(1)' } },
      ]),
    )
    expect(report.succeeded).toBe(2) // 两个都导入
    expect(report.failed).toBe(0)
    const bad = report.results.find((r) => r.name === '坏脚本') as { status: string; notes?: string[] }
    expect(bad.status).toBe('ok')
    expect((bad.notes ?? []).join(' ')).toContain('main.js:1:1')
    const stored = await readAllProjects()
    expect(stored.map((p) => p.name).sort()).toEqual(['坏脚本', '好脚本'])
    expect(stored.find((p) => p.name === '坏脚本')!.bundle).toBeUndefined() // 无产物落盘
    expect(stored.find((p) => p.name === '好脚本')!.bundle).toBeDefined()
  })

  it('matches 非法不拦：照常导入并原样落库（报错留给启用时 registerScript）', async () => {
    const report = await importScriptsZip(
      makeZipBase64([{ dir: 'bad', name: '规则坏', files: { 'main.js': 'x' }, matches: ['bad-rule'] }]),
    )
    expect(report.succeeded).toBe(1)
    expect(report.failed).toBe(0)
    const stored = await readAllProjects()
    expect(stored.map((p) => p.name)).toEqual(['规则坏'])
    expect(stored[0]!.config.matches).toEqual(['bad-rule'])
  })

  it('v 超版不再阻断：照常导入（开发期无版本规范）', async () => {
    const report = await importScriptsZip(
      makeZipBase64([{ dir: 'newer', name: '新版脚本', files: { 'main.js': 'x' }, v: 2 }]),
    )
    expect(report.succeeded).toBe(1)
    expect(report.failed).toBe(0)
    await expect(readAllProjects()).resolves.toHaveLength(1)
  })

  it('未导入的文件（顶层散文件 / 非 files/ 条目）汇进报告 ignored，不影响成功计数', async () => {
    const entries: Record<string, Uint8Array> = {
      'demo/project.json': strToU8(
        JSON.stringify({
          v: 1,
          name: '演示',
          config: { matches: ['*://*/*'], allFrames: true, runAt: 'document_end' },
          entry: 'main.js',
          exportedAt: 0,
        }),
      ),
      'demo/files/main.js': strToU8('console.log(1)'),
      'demo/data/x.json': strToU8('{}'),
      'loose.txt': strToU8('x'),
    }
    const report = await importScriptsZip(bytesToBase64(zipSync(entries)))
    expect(report.succeeded).toBe(1)
    expect(report.failed).toBe(0)
    expect(report.ignored.map((i) => i.path).sort()).toEqual(['demo/data/x.json', 'loose.txt'])
    expect(report.ignored.every((i) => i.status === 'ignored')).toBe(true)
  })

  it('非 zip 内容：整体报错（调用方 UI 展示错误）', async () => {
    await expect(importScriptsZip(bytesToBase64(new Uint8Array([1, 2, 3, 4])))).rejects.toThrow()
  })
})
