// project-write.ts 单测（offscreen 写侧）：测试直调写 API，通过 mock builder（esbuild-wasm）
// 与 us-git（lightning-fs + isomorphic-git）模拟 offscreen 上下文——这两个模块在真实环境里分别
// 依赖 chrome.runtime.getURL 拉起的 wasm 与 lightning-fs，均非被测靶心。
// 被测重点是写侧自身的语义：**保存恒成功、构建跟随**（2026-09-19 老大拍板：构建失败产物置空）、
// 守卫校验、提交失败不阻断、启停不产生提交、删除全部（记录批量清 + 仓整目录清一次），
// 以及 zip 导入「尽量导入」语义（2026-09-17 修订：非原则项不淘汰）。
// 存储分工（2026-09-19 重构后）：源码写 duoling-fs（writeSourceTree + commitSource），
// 状态库只存注册态（bundle + 元数据，无 files 字段）。
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
  writeSourceTree: vi.fn(async () => {}),
  commitSource: vi.fn(async () => ({ committed: true })),
  readSourceTree: vi.fn(async () => null),
  deleteRepo: vi.fn(async () => {}),
  deleteAllRepos: vi.fn(async () => 0),
}))

import { buildProject } from './builder'
import {
  clearDepsCache,
  createProject,
  importScriptsZip,
  rebuildPendingProjects,
  refreshDepsCache,
  removeAllProjects,
  removeProjectAndRepo,
  setProjectEnabled,
  saveExisting,
} from './project-write'
import { readAllProjects, removeProjects } from './state-db'
import { bytesToBase64 } from './zip-transfer'
import { commitSource, deleteAllRepos, deleteRepo, readSourceTree, writeSourceTree } from './us-git'

const mockWriteSourceTree = vi.mocked(writeSourceTree)
const mockCommitSource = vi.mocked(commitSource)
const mockReadSourceTree = vi.mocked(readSourceTree)
const mockDeleteRepo = vi.mocked(deleteRepo)
const mockDeleteAllRepos = vi.mocked(deleteAllRepos)
const mockBuild = vi.mocked(buildProject)

function validFiles(): Record<string, string> {
  return { 'main.js': 'console.log(1)' }
}

beforeEach(async () => {
  vi.clearAllMocks()
  mockCommitSource.mockResolvedValue({ committed: true })
  mockReadSourceTree.mockResolvedValue(null)
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
    expect(p.bundle).toBeDefined()
    expect(p.bundle!.code).toContain('bundled')
    expect(mockBuild).toHaveBeenCalledOnce()
  })

  it('连续创建不重名（1 → 2）', async () => {
    await createProject()
    const second = await createProject()
    expect(second.name).toBe('新建的脚本 2')
  })

  it('源码写 duoling-fs 工作区 + 提交 git（首次即建仓），状态库记录无 files 字段', async () => {
    const p = await createProject()
    await expect(readAllProjects()).resolves.toHaveLength(1)
    expect(mockWriteSourceTree).toHaveBeenCalledOnce()
    const [uuid, files, meta] = mockWriteSourceTree.mock.calls[0]
    expect(uuid).toBe(p.uuid)
    expect(files!['main.js']).toBeTruthy()
    expect(meta!.name).toBe(p.name)
    expect(mockCommitSource).toHaveBeenCalledOnce()
    expect(mockCommitSource.mock.calls[0]![2]).toBeUndefined() // 无备注
    expect(p).not.toHaveProperty('files') // 源码已迁出状态库
    expect(p.fileCount).toBe(1) // 文件数缓存在状态库记录上
  })

  it('构建失败仍创建成功：产物置空（保存恒成功语义）', async () => {
    mockBuild.mockRejectedValueOnce(
      new (await import('./builder')).BuildError(['main.js:1:1 语法错误']),
    )
    const p = await createProject()
    expect(p.bundle).toBeUndefined() // 产物置空
    await expect(readAllProjects()).resolves.toHaveLength(1) // 记录照常落库
    expect(mockWriteSourceTree).toHaveBeenCalledOnce() // 源码照常落 duoling-fs
    expect(mockCommitSource).toHaveBeenCalledOnce() // 版本照常提交
  })
})

describe('saveExisting', () => {
  it('脚本不存在抛错', async () => {
    await expect(saveExisting('ghost', validFiles(), 'main.js')).rejects.toThrow('脚本不存在')
  })

  it('文件树校验失败抛错且不写', async () => {
    const p = await createProject()
    mockWriteSourceTree.mockClear()
    await expect(saveExisting(p.uuid, {}, 'main.js')).rejects.toThrow('文件树不能为空')
    expect(mockWriteSourceTree).not.toHaveBeenCalled()
  })

  it('保存恒成功：构建跟随产生 bundle，提交带 note；enabled 保持原值', async () => {
    const p = await createProject()
    await setProjectEnabled(p.uuid, false)
    mockWriteSourceTree.mockClear()
    mockCommitSource.mockClear()
    mockBuild.mockImplementationOnce(async (files: Record<string, string>) => ({
      code: '//c2',
      files,
      remoteFetched: [],
    }))
    const outcome = await saveExisting(
      p.uuid,
      { 'main.js': '// v2', 'lib/a.js': 'x' },
      'main.js',
      { name: '  改名  ', note: '第一次保存' },
    )
    expect(outcome.buildOk).toBe(true)
    expect(outcome.project.name).toBe('改名') // 名称去空白
    expect(outcome.project.bundle!.code).toBe('//c2') // bundle 来自保存时的构建
    expect(outcome.project.buildOk).toBe(true) // 终态落库
    expect(outcome.project.lastBuildAt).toBeGreaterThan(0)
    expect(outcome.project.enabled).toBe(false)
    expect(outcome.project.updatedAt).toBeGreaterThanOrEqual(p.updatedAt)
    expect(mockWriteSourceTree).toHaveBeenCalledOnce()
    expect(mockWriteSourceTree.mock.calls[0]![1]).toEqual({ 'main.js': '// v2', 'lib/a.js': 'x' })
    expect(mockCommitSource).toHaveBeenCalledOnce()
    expect(mockCommitSource.mock.calls[0]![2]).toBe('第一次保存')
    expect(outcome.project.fileCount).toBe(2)
  })

  it('构建失败：产物置空 + issues 返回（不抛异常，保存仍成功）', async () => {
    const p = await createProject()
    mockBuild.mockRejectedValueOnce(
      new (await import('./builder')).BuildError(['main.js:1:1 语法错误']),
    )
    const outcome = await saveExisting(p.uuid, validFiles(), 'main.js')
    expect(outcome.buildOk).toBe(false)
    expect(outcome.issues).toEqual(['main.js:1:1 语法错误'])
    expect(outcome.project.bundle).toBeUndefined()
    expect(outcome.project.buildOk).toBe(false) // 终态落库：失败也记
    expect(outcome.project.lastBuildAt).toBeGreaterThan(0)
    await expect(readAllProjects()).resolves.toHaveLength(1) // 同 uuid 原地更新
  })

  it('名称全空白抛错', async () => {
    const p = await createProject()
    await expect(saveExisting(p.uuid, validFiles(), 'main.js', { name: '   ' })).rejects.toThrow(
      '脚本名称不能为空',
    )
  })

  it('config.matches 为空抛错', async () => {
    const p = await createProject()
    await expect(
      saveExisting(p.uuid, validFiles(), 'main.js', {
        config: { matches: [], allFrames: true, runAt: 'document_end' },
      }),
    ).rejects.toThrow('匹配规则（matches）至少一条')
  })

  it('不传 name / config 时保持原值', async () => {
    const p = await createProject()
    const outcome = await saveExisting(p.uuid, validFiles(), 'main.js')
    expect(outcome.project.name).toBe(p.name)
    expect(outcome.project.config).toEqual(p.config)
  })

  it('config.deps 透传给构建器（deps 内联的入参通道）', async () => {
    const p = await createProject()
    mockBuild.mockClear()
    const deps = ['https://cdn.example/jquery.js', 'https://cdn.example/style.css']
    await saveExisting(p.uuid, validFiles(), 'main.js', {
      config: { matches: ['*://*/*'], allFrames: true, runAt: 'document_end', deps },
    })
    expect(mockBuild).toHaveBeenCalledOnce()
    const [, , passedDeps] = mockBuild.mock.calls[0]
    expect(passedDeps).toEqual(deps)
  })

  it('构建补拉远程依赖：改写后的文件树再落盘 + 追加提交，fileCount 以最终树为准', async () => {
    const p = await createProject()
    mockWriteSourceTree.mockClear()
    mockCommitSource.mockClear()
    mockBuild.mockImplementationOnce(async () => ({
      code: '//with-dep',
      files: { 'main.js': 'console.log(1)', 'dep.js': 'fetched' },
      remoteFetched: ['dep.js'],
    }))
    const outcome = await saveExisting(p.uuid, validFiles(), 'main.js')
    expect(outcome.remoteFetched).toEqual(['dep.js'])
    expect(mockWriteSourceTree).toHaveBeenCalledTimes(2) // 首写 + 远程依赖回写
    expect(mockCommitSource).toHaveBeenCalledTimes(2) // 首提交 + 追加提交
    expect(outcome.project.fileCount).toBe(2)
  })
})

describe('setProjectEnabled', () => {
  it('只改 enabled，不产生提交', async () => {
    const p = await createProject()
    mockCommitSource.mockClear()
    const next = await setProjectEnabled(p.uuid, false)
    expect(next.enabled).toBe(false)
    expect(mockCommitSource).not.toHaveBeenCalled()
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

describe('removeAllProjects', () => {
  it('批量删除：状态库清空 + 整目录清一次仓，返回删除条数', async () => {
    await createProject()
    await createProject()
    expect(await readAllProjects()).toHaveLength(2)

    await expect(removeAllProjects()).resolves.toBe(2)
    await expect(readAllProjects()).resolves.toEqual([])
    // 逐个 deleteRepo 是重复劳动（随后整目录一并清），此路径只走整目录清一次
    expect(mockDeleteAllRepos).toHaveBeenCalledOnce()
    expect(mockDeleteRepo).not.toHaveBeenCalled()
  })

  it('空库调用：返回 0，不抛错（幂等，可重试）', async () => {
    await expect(removeAllProjects()).resolves.toBe(0)
    await expect(readAllProjects()).resolves.toEqual([])
    expect(mockDeleteRepo).not.toHaveBeenCalled()
  })
})

describe('提交失败策略', () => {
  it('saveExisting：提交失败只 warn，状态照常落盘（工作树已落地，下次保存补提交）', async () => {
    const p = await createProject()
    mockCommitSource.mockClear()
    mockCommitSource.mockRejectedValueOnce(new Error('git 崩了'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(saveExisting(p.uuid, validFiles(), 'main.js')).resolves.toMatchObject({ buildOk: true })
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

// —— zip 导入（保留原名 / enabled false / 单写方落盘）——

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
  it('单脚本导入：导入即返回（占位态 lastBuildAt=0），后台构建补终态 / enabled 恒 false / 保留原名', async () => {
    // 门控构建：让后台构建卡住，断言「导入返回 ≠ 构建完成」的解耦语义
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    mockBuild.mockImplementationOnce(() =>
      gate.then(() => Promise.resolve({ code: '//bundled(1)', files: { 'main.js': 'console.log(1)' }, remoteFetched: [] })),
    )
    const report = await importScriptsZip(
      makeZipBase64([{ dir: 'demo', name: '演示脚本', files: { 'main.js': 'console.log(1)' } }]),
    )
    expect(report.succeeded).toBe(1)
    expect(report.failed).toBe(0)
    const item = report.results[0]!
    expect(item.status).toBe('ok')
    const uuid = (item as { uuid: string }).uuid
    // 报告返回时构建被门控卡着：占位注册态 = 无产物 + lastBuildAt=0（「从未构建」哨兵）
    const placeholder = (await readAllProjects()).find((p) => p.uuid === uuid)
    expect(placeholder).toBeDefined()
    expect(placeholder!.enabled).toBe(false)
    expect(placeholder!.name).toBe('演示脚本')
    expect(placeholder!.bundle).toBeUndefined()
    expect(placeholder!.lastBuildAt).toBe(0)
    // 源码落 duoling-fs（导入首要落点），提交 note = 「从 zip 导入」
    expect(mockWriteSourceTree).toHaveBeenCalledOnce()
    expect(mockCommitSource).toHaveBeenCalledOnce()
    expect(mockCommitSource.mock.calls[0]![2]).toBe('从 zip 导入')
    // 放行后台构建 → 终态落库（等状态库出现产物，不是等 build 被调——被调时可能还卡在门里）
    release()
    const stored = await vi.waitFor(async () => {
      const s = (await readAllProjects()).find((p) => p.uuid === uuid)
      expect(s?.bundle).toBeDefined()
      return s
    })
    expect(stored!.buildOk).toBe(true)
    expect(stored!.lastBuildAt).toBeGreaterThan(0)
  })

  it('重复导入同一内容：仍导入为独立副本，报告带 duplicateOf 提示', async () => {
    const zip = makeZipBase64([{ dir: 'demo', name: '演示', files: { 'main.js': 'console.log(1)' } }])
    const first = await importScriptsZip(zip)
    expect(first.results[0]).toMatchObject({ status: 'ok' })
    expect(first.results[0]).not.toHaveProperty('duplicateOf')
    // 指纹去重读既有脚本的源码树：mock 返回与导入内容一致的第一份记录
    const firstUuid = (first.results[0] as { uuid: string }).uuid
    mockReadSourceTree.mockImplementation(async (uuid: string) =>
      uuid === firstUuid
        ? {
            meta: { name: '演示', config: { matches: ['*://*/*'], allFrames: true, runAt: 'document_end' }, entry: 'main.js', createdAt: 0 },
            files: { 'main.js': 'console.log(1)' },
          }
        : null,
    )
    const second = await importScriptsZip(zip)
    expect(second.succeeded).toBe(1)
    expect(second.results[0]).toMatchObject({ status: 'ok', duplicateOf: '演示' })
    await expect(readAllProjects()).resolves.toHaveLength(2)
  })

  it('后台构建失败不淘汰：脚本已导入（产物置空，终态 = 失败），源码照常提交', async () => {
    mockBuild.mockRejectedValueOnce(new (await import('./builder')).BuildError(['main.js:1:1 语法错误']))
    const report = await importScriptsZip(
      makeZipBase64([
        { dir: 'bad', name: '坏脚本', files: { 'main.js': 'syntax error here' } },
        { dir: 'good', name: '好脚本', files: { 'main.js': 'console.log(1)' } },
      ]),
    )
    expect(report.succeeded).toBe(2) // 两个都导入（构建在后台，报告不再携带构建诊断）
    expect(report.failed).toBe(0)
    const bad = report.results.find((r) => r.name === '坏脚本') as { status: string; notes?: string[] }
    expect(bad.status).toBe('ok')
    expect(bad.notes).toBeUndefined()
    await vi.waitFor(() => expect(mockBuild).toHaveBeenCalledTimes(2))
    const stored = await readAllProjects()
    expect(stored.map((p) => p.name).sort()).toEqual(['坏脚本', '好脚本'])
    const badStored = stored.find((p) => p.name === '坏脚本')!
    expect(badStored.bundle).toBeUndefined() // 产物置空
    expect(badStored.buildOk).toBe(false)
    expect(badStored.lastBuildAt).toBeGreaterThan(0) // 有终态时刻 → 列表按「构建失败」展示
    expect(stored.find((p) => p.name === '好脚本')!.bundle).toBeDefined()
    // 源码照常写工作区；构建失败不再跳过提交（统一保存语义）
    expect(mockWriteSourceTree).toHaveBeenCalledTimes(2)
    expect(mockCommitSource).toHaveBeenCalledTimes(2)
  })

  it('后台构建非 BuildError 异常：状态停在 lastBuildAt=0，启动对账重新排队补终态', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockBuild.mockRejectedValueOnce(new Error('wasm 引导崩了')) // 非 BuildError → 队列 catch，状态不更新
    const report = await importScriptsZip(
      makeZipBase64([{ dir: 'demo', name: '演示', files: { 'main.js': 'console.log(1)' } }]),
    )
    const uuid = (report.results[0] as { uuid: string }).uuid
    await vi.waitFor(() => expect(mockBuild).toHaveBeenCalledOnce())
    expect((await readAllProjects()).find((p) => p.uuid === uuid)!.lastBuildAt).toBe(0) // 悬挂态
    warn.mockRestore()
    // 下次 offscreen 启动对账：lastBuildAt=0 的脚本重新入队（对账读工作树取码），构建成功补终态
    mockReadSourceTree.mockImplementation(async (u: string) =>
      u === uuid
        ? {
            meta: { name: '演示', config: { matches: ['*://*/*'], allFrames: true, runAt: 'document_end' }, entry: 'main.js', createdAt: 0 },
            files: { 'main.js': 'console.log(1)' },
          }
        : null,
    )
    await rebuildPendingProjects()
    await vi.waitFor(() => expect(mockBuild).toHaveBeenCalledTimes(2))
    const stored = (await readAllProjects()).find((p) => p.uuid === uuid)!
    expect(stored.buildOk).toBe(true)
    expect(stored.lastBuildAt).toBeGreaterThan(0)
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

// —— 依赖缓存管理（清 / 刷，2026-09-19 老大拍板拆两个动作）——

describe('依赖缓存管理', () => {
  /** 给定 uuid 种一棵工作树：withDeps=true 时带 _deps/（index + 内容文件各一） */
  function seedTree(uuid: string, withDeps: boolean): void {
    mockReadSourceTree.mockImplementation(async (u: string) =>
      u === uuid
        ? {
            meta: {
              name: '演示',
              config: withDeps
                ? { matches: ['*://*/*'], allFrames: true, runAt: 'document_end', deps: ['https://cdn.example/jquery.js'] }
                : { matches: ['*://*/*'], allFrames: true, runAt: 'document_end' },
              entry: 'main.js',
              createdAt: 0,
            },
            files: (withDeps
              ? {
                  'main.js': 'console.log(1)',
                  '_deps/index.json': '{"https://cdn.example/jquery.js":{"file":"_deps/abc.js","kind":"script","mode":"text"}}',
                  '_deps/abc.js': 'old-cache',
                }
              : { 'main.js': 'console.log(1)' }) as Record<string, string>,
          }
        : null,
    )
  }

  it('清缓存：只删 _deps/（不拉不建），产物与启用态保留，fileCount 收缩', async () => {
    const p = await createProject()
    seedTree(p.uuid, true)
    const res = await clearDepsCache(p.uuid)
    expect(res.cleared).toBe(2)
    const [uuid, files] = mockWriteSourceTree.mock.calls.at(-1)!
    expect(uuid).toBe(p.uuid)
    expect(Object.keys(files!).some((f) => f.startsWith('_deps/'))).toBe(false)
    const stored = (await readAllProjects()).find((x) => x.uuid === p.uuid)
    expect(stored!.bundle).toBeDefined() // 产物未动：脚本继续跑旧产物
    expect(stored!.fileCount).toBe(1)
    expect(mockCommitSource.mock.calls.at(-1)![2]).toBe('清依赖缓存')
  })

  it('清缓存：无 _deps 时返回 0 且不产生任何写', async () => {
    const p = await createProject()
    seedTree(p.uuid, false)
    mockWriteSourceTree.mockClear()
    mockCommitSource.mockClear()
    await expect(clearDepsCache(p.uuid)).resolves.toEqual({ cleared: 0 })
    expect(mockWriteSourceTree).not.toHaveBeenCalled()
    expect(mockCommitSource).not.toHaveBeenCalled()
  })

  it('刷缓存：全成功 → 新依赖落盘 + 重建产物 + 状态库更新', async () => {
    const p = await createProject()
    seedTree(p.uuid, true)
    mockBuild.mockImplementationOnce(async (files: Record<string, string>) => ({
      code: '//refreshed',
      files: { ...files, '_deps/abc.js': 'new-cache' },
      remoteFetched: ['https://cdn.example/jquery.js'],
    }))
    const res = await refreshDepsCache(p.uuid)
    expect(res).toMatchObject({ ok: true, refreshed: ['https://cdn.example/jquery.js'] })
    const [uuid, files] = mockWriteSourceTree.mock.calls.at(-1)!
    expect(uuid).toBe(p.uuid)
    expect(files!['_deps/abc.js']).toBe('new-cache')
    const stored = (await readAllProjects()).find((x) => x.uuid === p.uuid)
    expect(stored!.bundle!.code).toBe('//refreshed')
    expect(stored!.buildOk).toBe(true)
    expect(stored!.lastBuildAt).toBeGreaterThan(0)
  })

  it('刷缓存：拉取/构建失败 → ok=false 且缓存未动（无落盘无提交）', async () => {
    const p = await createProject()
    seedTree(p.uuid, true)
    mockBuild.mockRejectedValueOnce(new (await import('./builder')).BuildError(['依赖刷新失败（已保留旧缓存，未做任何替换）：x']))
    mockWriteSourceTree.mockClear()
    mockCommitSource.mockClear()
    const res = await refreshDepsCache(p.uuid)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.issues[0]).toContain('旧缓存')
    expect(mockWriteSourceTree).not.toHaveBeenCalled()
    expect(mockCommitSource).not.toHaveBeenCalled()
  })
})
