// project-write.ts 单测（offscreen 写侧）：测试直调写 API，通过 mock builder（esbuild-wasm）
// 与 us-git（lightning-fs）模拟 offscreen 上下文——这两个模块在真实环境里分别依赖
// chrome.runtime.getURL 拉起的 wasm 与 lightning-fs，均非层1靶心。
// 被测重点是写侧自身的语义：bundle 必要条件、守卫校验、快照失败不阻断、启停不产生提交。
import 'fake-indexeddb/auto'
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
  removeProjectAndRepo,
  setProjectEnabled,
  updateProjectFiles,
} from './project-write'
import { readAllProjects, removeProjects } from './state-db'
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
