// 协议一致性测试（层 2，docs/testing-plan.md）—— offscreen 端命令分发与应答信封。
//
// 断言 (b)：offscreen 三个 handle*（state / ai-fs / build）对其 Request union 成员**全覆盖**。
// offscreen-main 的路由是 `kind.startsWith('ai:'/'state:')` + `as` 断言，union 新增成员而
// 分发处漏接 switch case 时编译器不报错（函数返回 Promise<unknown>，漏接 = 静默 undefined）
// ——用「类型层穷尽性校验 + 表驱动派发 + 后端 mock 被触达」三道闸钉死。
//
// 断言 (c)：应答信封恒为 { ok: boolean, data | error } 形状。走 offscreen-main 注册的真实
// onMessage 监听器（经 fakeBrowser.runtime.sendMessage 端到端触发），成功 / 失败 / 让路三路都验。
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { RuntimeRequest } from '@/shared/extension-ipc'
import type { ScriptProject } from './types'
import { handleStateCommand, type StateRequest } from '@/lib/userscripts/offscreen-state-commands'
import { handleAiFsCommand, type AiFsRequest } from '@/lib/userscripts/offscreen-fs-commands'
import { handleBuildCommand, type BuildRequest } from '@/lib/userscripts/offscreen-build-commands'
import * as projectWrite from '@/lib/userscripts/project-write'
import * as projectStore from '@/lib/userscripts/project-store'
import * as usGit from '@/lib/userscripts/us-git'
import * as usFs from '@/lib/userscripts/us-fs'
import * as builder from '@/lib/userscripts/builder'
import { fakeBrowser } from 'wxt/testing/fake-browser'

// —— 依赖 mock：offscreen 命令面的全部后端（fs / git / IDB / esbuild 一律不真碰）——
vi.mock('@/lib/userscripts/project-store', () => ({
  getProject: vi.fn(),
  listProjects: vi.fn(),
  nextScriptName: vi.fn(),
  validateFiles: vi.fn(),
}))
vi.mock('@/lib/userscripts/project-write', () => ({
  createProject: vi.fn(),
  removeProjectAndRepo: vi.fn(),
  setProjectEnabled: vi.fn(),
  updateProjectFiles: vi.fn(),
}))
vi.mock('@/lib/userscripts/us-fs', () => ({
  fs: {},
  pfs: { readdir: vi.fn() },
  readLfsFile: vi.fn(),
  readLfsTree: vi.fn(),
}))
vi.mock('@/lib/userscripts/us-git', () => ({
  ensureRepo: vi.fn(),
  deleteRepo: vi.fn(),
  snapshotProject: vi.fn(),
  listHistory: vi.fn(),
  readTreeAt: vi.fn(),
  restoreToCommit: vi.fn(),
  writeWorktree: vi.fn(),
  readWorktree: vi.fn(),
}))
// BuildError 是真类（handleBuildCommand 用 instanceof 分流），mock 里给出实现
vi.mock('@/lib/userscripts/builder', () => {
  class BuildError extends Error {
    constructor(readonly issues: string[]) {
      super('构建失败')
    }
  }
  return { buildProject: vi.fn(), BuildError }
})
// reconcileFs 启动对账会真碰 fs/IDB，且与本测试无关——保留其余真实导出
vi.mock('@/lib/userscripts/offscreen-state-commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/userscripts/offscreen-state-commands')>()
  return { ...actual, reconcileFs: vi.fn(async () => {}) }
})

type Expect<T extends true> = T
type AnyMock = Mock

const FILES = { 'main.ts': 'console.log(1)' }
const BUNDLE = { code: '/* bundle */', builtAt: 1 }
// 完整 ScriptProject 形状（ai:writeDraft 的载荷、ai:restoreToCommit 的前置读取都吃它）
const PROJECT: ScriptProject = {
  v: 1,
  uuid: 'u1',
  name: '脚本一',
  enabled: true,
  config: { matches: ['https://example.com/*'], allFrames: false, runAt: 'document_end' },
  files: FILES,
  entry: 'main.ts',
  bundle: BUNDLE,
  createdAt: 0,
  updatedAt: 0,
}

// ============================== (b) 分发全覆盖 ==============================

describe('(b) handleStateCommand 分发全覆盖', () => {
  // union 成员清单：typecheck 闸——StateRequest 新增成员而未登记 → Exclude 非 never → 编译失败
  const STATE_KINDS = [
    'state:create',
    'state:updateFiles',
    'state:remove',
    'state:toggle',
  ] as const satisfies readonly StateRequest['kind'][]
  const _exhaustive: Expect<
    Exclude<StateRequest['kind'], (typeof STATE_KINDS)[number]> extends never ? true : false
  > = true

  // Record keyed by kind：登记表少一个 case → typecheck 失败
  const CASES: Record<
    (typeof STATE_KINDS)[number],
    { msg: StateRequest; backend: Mock; args: unknown[] }
  > = {
    'state:create': { msg: { kind: 'state:create' }, backend: vi.mocked(projectWrite.createProject), args: [] },
    'state:updateFiles': {
      msg: { kind: 'state:updateFiles', uuid: 'u1', files: FILES, entry: 'main.ts', bundle: BUNDLE, name: '新名', note: '备注' },
      backend: vi.mocked(projectWrite.updateProjectFiles),
      args: ['u1', FILES, 'main.ts', BUNDLE, { name: '新名', config: undefined, note: '备注' }],
    },
    'state:remove': {
      msg: { kind: 'state:remove', uuid: 'u1' },
      backend: vi.mocked(projectWrite.removeProjectAndRepo),
      args: ['u1'],
    },
    'state:toggle': {
      msg: { kind: 'state:toggle', uuid: 'u1', enabled: true },
      backend: vi.mocked(projectWrite.setProjectEnabled),
      args: ['u1', true],
    },
  }

  beforeEach(() => vi.clearAllMocks())

  it('union 穷尽性闸就位（新增 state:* 成员而漏登记时 typecheck 先失败）', () => {
    expect(_exhaustive).toBe(true)
  })

  it.each(Object.entries(CASES))('%s → 转发对应写后端', async (kind, c) => {
    const result = await handleStateCommand(c.msg)
    // 「无 default 静默漏接」的运行时判据：每个 kind 都必须触达恰好一个后端
    expect(c.backend, `${kind} 应转发后端`).toHaveBeenCalledTimes(1)
    expect(c.backend).toHaveBeenCalledWith(...c.args)
    // 后端返回值原样作为 data 回传（undefined 也原样）
    expect(result).toBe(c.backend.mock.results[0]?.value)
  })
})

describe('(b) handleAiFsCommand 分发全覆盖', () => {
  // ai:build 不在此表：它在 offscreen-main 路由里先于 ai: 前缀被拦下、由 handleBuildCommand
  // 处理（见下方 describe）——本表须与其余 ai:* 成员一一对应。
  const AI_FS_KINDS = [
    'ai:ping',
    'ai:history',
    'ai:historyTree',
    'ai:restoreToCommit',
    'ai:lfsTree',
    'ai:writeDraft',
    'ai:readDraft',
    'ai:lfsReadFile',
  ] as const satisfies readonly Exclude<AiFsRequest['kind'], 'ai:build'>[]
  const _exhaustive: Expect<
    Exclude<AiFsRequest['kind'], (typeof AI_FS_KINDS)[number] | 'ai:build'> extends never ? true : false
  > = true
  // BuildRequest 与联合成员保持同一形状（它是独立声明的第二真相源，任一侧漂移在此暴露）
  const _buildReqMatchesUnion: Expect<
    BuildRequest extends Extract<RuntimeRequest, { kind: 'ai:build' }> ? true : false
  > = true
  const _unionMatchesBuildReq: Expect<
    Extract<RuntimeRequest, { kind: 'ai:build' }> extends BuildRequest ? true : false
  > = true

  const CASES: Record<
    (typeof AI_FS_KINDS)[number],
    { msg: AiFsRequest; backend?: Mock; args?: unknown[]; result?: unknown; setup?: () => void }
  > = {
    'ai:ping': {
      // 就绪探测不触碰任何后端，直接返回常量
      msg: { kind: 'ai:ping' },
      result: { ready: true },
    },
    'ai:history': { msg: { kind: 'ai:history', uuid: 'u1' }, backend: vi.mocked(usGit.listHistory), args: ['u1'] },
    'ai:historyTree': {
      msg: { kind: 'ai:historyTree', uuid: 'u1', oid: 'o1' },
      backend: vi.mocked(usGit.readTreeAt),
      args: ['u1', 'o1'],
    },
    'ai:restoreToCommit': {
      msg: { kind: 'ai:restoreToCommit', uuid: 'u1', oid: 'o1' },
      backend: vi.mocked(usGit.restoreToCommit),
      args: [PROJECT, 'o1'],
      setup: () => vi.mocked(projectStore.getProject).mockResolvedValue(PROJECT),
    },
    'ai:lfsTree': { msg: { kind: 'ai:lfsTree' }, backend: vi.mocked(usFs.readLfsTree), args: ['/'] },
    'ai:writeDraft': {
      msg: { kind: 'ai:writeDraft', uuid: 'u1', project: PROJECT },
      backend: vi.mocked(usGit.writeWorktree),
      args: ['u1', PROJECT],
      result: { saved: true },
    },
    'ai:readDraft': {
      msg: { kind: 'ai:readDraft', uuid: 'u1' },
      backend: vi.mocked(usGit.readWorktree),
      args: ['u1'],
    },
    'ai:lfsReadFile': {
      msg: { kind: 'ai:lfsReadFile', path: '/uscripts/u1/files/main.ts' },
      backend: vi.mocked(usFs.readLfsFile),
      args: ['/uscripts/u1/files/main.ts'],
    },
  }

  beforeEach(() => vi.clearAllMocks())

  it('union 穷尽性闸就位（新增 ai:* 成员而漏登记时 typecheck 先失败）', () => {
    expect(_exhaustive).toBe(true)
    expect(_buildReqMatchesUnion).toBe(true)
    expect(_unionMatchesBuildReq).toBe(true)
  })

  it.each(Object.entries(CASES))('%s → 分发正确', async (kind, c) => {
    c.setup?.()
    const result = await handleAiFsCommand(c.msg)
    if (c.backend) {
      expect(c.backend, `${kind} 应触达后端`).toHaveBeenCalledTimes(1)
      expect(c.backend).toHaveBeenCalledWith(...(c.args ?? []))
    } else {
      // 无后端的 kind（就绪探测）：任何 git / fs 后端都不该被碰
      const touched = [...Object.values(usGit), ...Object.values(usFs)].some(
        (fn) => (fn as unknown as Mock).mock?.calls.length > 0,
      )
      expect(touched, `${kind} 不应触达任何后端`).toBe(false)
    }
    if (c.result !== undefined) expect(result).toEqual(c.result)
  })

  it('ai:writeDraft 先 ensureRepo 再 writeWorktree（顺序契约）', async () => {
    await handleAiFsCommand({ kind: 'ai:writeDraft', uuid: 'u1', project: PROJECT })
    const ensureOrder = vi.mocked(usGit.ensureRepo).mock.invocationCallOrder[0]
    const writeOrder = vi.mocked(usGit.writeWorktree).mock.invocationCallOrder[0]
    expect(ensureOrder).toBeLessThan(writeOrder!)
  })

  it('ai:restoreToCommit 遇到不存在的脚本 → throw（由分发层包成 error 信封）', async () => {
    // clearAllMocks 不清实现：显式覆盖为「脚本不存在」
    vi.mocked(projectStore.getProject).mockResolvedValue(undefined)
    await expect(handleAiFsCommand({ kind: 'ai:restoreToCommit', uuid: 'nope', oid: 'o1' })).rejects.toThrow(
      '脚本不存在',
    )
    expect(usGit.restoreToCommit).not.toHaveBeenCalled()
  })
})

describe('(b) handleBuildCommand 分发与「不跨 IPC 抛」契约', () => {
  beforeEach(() => vi.clearAllMocks())

  it('ai:build → buildProject(files, entry)，成功包成 { status: ok }', async () => {
    const outcome = { code: '/* built */', warnings: [] }
    vi.mocked(builder.buildProject).mockResolvedValue(outcome as never)
    const result = await handleBuildCommand({ kind: 'ai:build', files: FILES, entry: 'main.ts' })
    expect(builder.buildProject).toHaveBeenCalledWith(FILES, 'main.ts')
    expect(result).toEqual({ status: 'ok', outcome })
  })

  it('BuildError → { status: buildError, issues }（issues 不丢，编辑器行内展示依赖它）', async () => {
    vi.mocked(builder.buildProject).mockRejectedValue(new builder.BuildError(['main.ts:1:1 oops']))
    const result = await handleBuildCommand({ kind: 'ai:build', files: FILES, entry: 'main.ts' })
    expect(result).toEqual({ status: 'buildError', issues: ['main.ts:1:1 oops'] })
  })

  it('其它异常 → { status: error, message }（自身不抛，全部进结果联合）', async () => {
    vi.mocked(builder.buildProject).mockRejectedValue(new Error('wasm 挂了'))
    const result = await handleBuildCommand({ kind: 'ai:build', files: FILES, entry: 'main.ts' })
    expect(result).toEqual({ status: 'error', message: 'wasm 挂了' })
  })
})

// ============================== (c) 应答信封形状 ==============================

describe('(c) offscreen 应答信封 { ok, data | error }', () => {
  // 走真实入口（offscreen-main.ts）注册的 onMessage 监听器：它内部经 respond() 统一包信封。
  // fakeBrowser.runtime.sendMessage 会触发全部已注册监听器：监听器 return true 并回包 →
  // promise resolve 该包；return false 让路 → resolve undefined。
  beforeAll(async () => {
    await import('@/entrypoints/app/offscreen-main')
  })

  const reply = (msg: unknown): Promise<unknown> =>
    fakeBrowser.runtime.sendMessage(msg) as Promise<unknown>

  /** 信封校验：恒有 ok:boolean；成功恒带 data、失败恒带非空 string error，无多余字段 */
  function expectEnvelope(res: unknown): void {
    expect(res, '应答必须是信封而非裸值').toBeTypeOf('object')
    expect(res).not.toBeNull()
    const r = res as Record<string, unknown>
    expect(typeof r.ok).toBe('boolean')
    if (r.ok === true) {
      expect(Object.keys(r).sort()).toEqual(['data', 'ok'])
    } else {
      expect(Object.keys(r).sort()).toEqual(['error', 'ok'])
      expect(typeof r.error).toBe('string')
      expect((r.error as string).length).toBeGreaterThan(0)
    }
  }

  // offscreen 管辖的全部 kind（与 extension-ipc.test.ts 的归属表互为印证），
  // 全部经真实监听器走一遍，任何一路信封走样（漏 data / 裸抛错误对象 / 多余字段）都会被抓住
  const OFFSCREEN_MSGS: RuntimeRequest[] = [
    { kind: 'ai:ping' },
    { kind: 'ai:history', uuid: 'u1' },
    { kind: 'ai:historyTree', uuid: 'u1', oid: 'o1' },
    { kind: 'ai:restoreToCommit', uuid: 'u1', oid: 'o1' },
    { kind: 'ai:lfsTree' },
    { kind: 'ai:build', files: FILES, entry: 'main.ts' },
    { kind: 'ai:writeDraft', uuid: 'u1', project: PROJECT },
    { kind: 'ai:readDraft', uuid: 'u1' },
    { kind: 'ai:lfsReadFile', path: '/uscripts/u1/files/main.ts' },
    { kind: 'state:create' },
    { kind: 'state:updateFiles', uuid: 'u1', files: FILES, entry: 'main.ts', bundle: BUNDLE },
    { kind: 'state:remove', uuid: 'u1' },
    { kind: 'state:toggle', uuid: 'u1', enabled: true },
  ]

  beforeEach(() => vi.clearAllMocks())

  it.each(OFFSCREEN_MSGS.map((m) => [m.kind, m] as const))(
    '%s → 信封形状恒定（成功或业务失败均不裸抛）',
    async (_kind, msg) => {
      expectEnvelope(await reply(msg))
    },
  )

  it('成功路径：data 承载后端返回值', async () => {
    expect(await reply({ kind: 'state:remove', uuid: 'u1' })).toEqual({ ok: true, data: undefined })
  })

  it('失败路径：后端 throw → { ok: false, error: message }，不向外泄漏 Error 对象', async () => {
    vi.mocked(projectWrite.createProject).mockRejectedValueOnce(new Error('IDB 打不开'))
    const res = await reply({ kind: 'state:create' })
    expect(res).toEqual({ ok: false, error: 'IDB 打不开' })
  })

  it('ai:ping 经监听器应答 { ok: true, data: { ready: true } }（SW 就绪探测的判据）', async () => {
    expect(await reply({ kind: 'ai:ping' })).toEqual({ ok: true, data: { ready: true } })
  })

  it('SW 管辖的 kind：offscreen 静默让路（无响应，由 SW 应答）', async () => {
    await expect(reply({ kind: 'userscript:list' })).resolves.toBeUndefined()
    await expect(reply({ kind: 'offscreen:ensure' })).resolves.toBeUndefined()
    await expect(reply({ kind: 'sw:buildInfo' })).resolves.toBeUndefined()
  })

  it('OffscreenPush（offscreen:configChanged）是单向推送：触发回拉但不回包', async () => {
    await expect(reply({ kind: 'offscreen:configChanged' })).resolves.toBeUndefined()
  })

  it('未知 kind：不回包也不崩（静默比假错误诚实）', async () => {
    await expect(reply({ kind: 'chat:unknown' })).resolves.toBeUndefined()
  })
})
