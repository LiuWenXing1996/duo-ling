// 协议一致性测试 —— offscreen 端命令分发与应答信封。
//
// 断言 (b)：offscreen 两个 handle*（state / fs）对其 Request union 成员**全覆盖**。
// offscreen-main 的路由是 `kind.startsWith('ai:'/'state:')` + `as` 断言，union 新增成员而
// 分发处漏接 switch case 时编译器不报错（函数返回 Promise<unknown>，漏接 = 静默 undefined）
// ——用「类型层穷尽性校验 + 表驱动派发 + 后端 mock 被触达」三道闸钉死。
//
// 断言 (c)：应答信封恒为 { ok: boolean, data | error } 形状。走 offscreen-main 注册的真实
// onMessage 监听器（经 fakeBrowser.runtime.sendMessage 端到端触发），成功 / 失败 / 让路三路都验。
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { RuntimeRequest } from '@/shared/extension-ipc'
import type { ScriptMeta, ScriptProject } from './types'
import { handleStateCommand, type StateRequest } from '@/lib/userscripts/offscreen-state-commands'
import { handleFsCommand, type FsRequest } from '@/lib/userscripts/offscreen-fs-commands'
import * as projectWrite from '@/lib/userscripts/project-write'
import * as usGit from '@/lib/userscripts/us-git'
import * as usFs from '@/lib/userscripts/us-fs'
import { fakeBrowser } from 'wxt/testing/fake-browser'

// —— 依赖 mock：offscreen 命令面的全部后端（fs / git / IDB 一律不真碰）——
vi.mock('@/lib/userscripts/project-store', () => ({
  getProject: vi.fn(),
  listProjects: vi.fn(),
  nextScriptName: vi.fn(),
}))
vi.mock('@/lib/userscripts/project-write', () => ({
  createProject: vi.fn(),
  createGeneratedProject: vi.fn(),
  importScriptsZip: vi.fn(),
  removeAllProjects: vi.fn(),
  removeProjectAndRepo: vi.fn(),
  setProjectEnabled: vi.fn(),
  saveExisting: vi.fn(),
  createGroup: vi.fn(),
  renameGroup: vi.fn(),
  removeGroupAndReassign: vi.fn(),
  reorderGroups: vi.fn(),
  setProjectGroup: vi.fn(),
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
  deleteAllRepos: vi.fn(),
  listHistory: vi.fn(),
  readSnapshotAt: vi.fn(),
  restoreToCommit: vi.fn(),
  writeSource: vi.fn(),
  commitSource: vi.fn(),
  readSource: vi.fn(),
}))
// reconcileFs 启动对账会真碰 fs/IDB，且与本测试无关——保留其余真实导出
vi.mock('@/lib/userscripts/offscreen-state-commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/userscripts/offscreen-state-commands')>()
  return { ...actual, reconcileFs: vi.fn(async () => {}) }
})

type Expect<T extends true> = T

const CODE = 'console.log(1)'
const META: ScriptMeta = {
  name: '脚本一',
  config: { matches: ['https://example.com/*'], allFrames: false, runAt: 'document_end' },
  createdAt: 0,
}
// 完整 ScriptProject 形状（state:createProject 的载荷；源码搬运副本在 source 字段）
const PROJECT: ScriptProject = {
  v: 2,
  uuid: 'u1',
  name: '脚本一',
  enabled: true,
  config: META.config,
  group: '',
  source: { code: CODE, savedAt: 1 },
  createdAt: 0,
  updatedAt: 0,
}

// ============================== (b) 分发全覆盖 ==============================

describe('(b) handleStateCommand 分发全覆盖', () => {
  // union 成员清单：typecheck 闸——StateRequest 新增成员而未登记 → Exclude 非 never → 编译失败
  const STATE_KINDS = [
    'state:create',
    'state:createProject',
    'state:save',
    'state:remove',
    'state:removeAll',
    'state:toggle',
    'state:import',
    'state:group-create',
    'state:group-rename',
    'state:group-remove',
    'state:group-reorder',
    'state:set-group',
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
    'state:createProject': {
      msg: {
        kind: 'state:createProject',
        name: '脚本一',
        config: PROJECT.config,
        code: CODE,
        enabled: false,
        note: 'AI 生成',
      },
      backend: vi.mocked(projectWrite.createGeneratedProject),
      args: [
        { name: '脚本一', config: PROJECT.config, code: CODE, enabled: false, note: 'AI 生成' },
      ],
    },
    'state:save': {
      msg: { kind: 'state:save', uuid: 'u1', code: CODE, name: '新名', note: '备注' },
      backend: vi.mocked(projectWrite.saveExisting),
      args: ['u1', CODE, { name: '新名', config: undefined, note: '备注' }],
    },
    'state:remove': {
      msg: { kind: 'state:remove', uuid: 'u1' },
      backend: vi.mocked(projectWrite.removeProjectAndRepo),
      args: ['u1'],
    },
    'state:removeAll': {
      msg: { kind: 'state:removeAll' },
      backend: vi.mocked(projectWrite.removeAllProjects),
      args: [],
    },
    'state:toggle': {
      msg: { kind: 'state:toggle', uuid: 'u1', enabled: true },
      backend: vi.mocked(projectWrite.setProjectEnabled),
      args: ['u1', true],
    },
    'state:import': {
      msg: { kind: 'state:import', zipBase64: 'emlwLWJ5dGVz' },
      backend: vi.mocked(projectWrite.importScriptsZip),
      args: ['emlwLWJ5dGVz'],
    },
    'state:group-create': {
      msg: { kind: 'state:group-create', name: '购物助手' },
      backend: vi.mocked(projectWrite.createGroup),
      args: ['购物助手'],
    },
    'state:group-rename': {
      msg: { kind: 'state:group-rename', id: 'g1', name: '新名' },
      backend: vi.mocked(projectWrite.renameGroup),
      args: ['g1', '新名'],
    },
    'state:group-remove': {
      msg: { kind: 'state:group-remove', id: 'g1' },
      backend: vi.mocked(projectWrite.removeGroupAndReassign),
      args: ['g1'],
    },
    'state:group-reorder': {
      msg: { kind: 'state:group-reorder', orderedIds: ['g2', 'g1'] },
      backend: vi.mocked(projectWrite.reorderGroups),
      args: [['g2', 'g1']],
    },
    'state:set-group': {
      msg: { kind: 'state:set-group', uuid: 'u1', group: 'g1' },
      backend: vi.mocked(projectWrite.setProjectGroup),
      args: ['u1', 'g1'],
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

describe('(b) handleFsCommand 分发全覆盖', () => {
  // fs:* 全成员清单：typecheck 闸——新增成员而未登记 → Exclude 非 never → 编译失败
  const FS_KINDS = [
    'fs:ping',
    'fs:read',
    'fs:history',
    'fs:readAt',
    'fs:restoreToCommit',
    'fs:exportZip',
    'fs:lfsTree',
    'fs:lfsReadFile',
  ] as const satisfies readonly FsRequest['kind'][]
  const _exhaustive: Expect<
    Exclude<FsRequest['kind'], (typeof FS_KINDS)[number]> extends never ? true : false
  > = true
  const CASES: Record<
    (typeof FS_KINDS)[number],
    { msg: FsRequest; backend?: Mock; args?: unknown[]; result?: unknown; setup?: () => void }
  > = {
    'fs:ping': {
      // 就绪探测不触碰任何后端，直接返回常量
      msg: { kind: 'fs:ping' },
      result: { ready: true },
    },
    'fs:read': {
      msg: { kind: 'fs:read', uuid: 'u1' },
      backend: vi.mocked(usGit.readSource),
      args: ['u1'],
    },
    'fs:history': { msg: { kind: 'fs:history', uuid: 'u1' }, backend: vi.mocked(usGit.listHistory), args: ['u1'] },
    'fs:readAt': {
      msg: { kind: 'fs:readAt', uuid: 'u1', oid: 'o1' },
      backend: vi.mocked(usGit.readSnapshotAt),
      args: ['u1', 'o1'],
    },
    'fs:restoreToCommit': {
      msg: { kind: 'fs:restoreToCommit', uuid: 'u1', oid: 'o1' },
      backend: vi.mocked(usGit.restoreToCommit),
      args: ['u1', 'o1'],
    },
    'fs:exportZip': {
      // readSource mock 返回 null → source 为 null → 空 payload 走真实 fflate 打包
      msg: { kind: 'fs:exportZip', uuids: ['u1'] },
      backend: vi.mocked(usGit.readSource),
      args: ['u1'],
      setup: () => vi.mocked(usGit.readSource).mockResolvedValue(null),
    },
    'fs:lfsTree': { msg: { kind: 'fs:lfsTree' }, backend: vi.mocked(usFs.readLfsTree), args: ['/'] },
    'fs:lfsReadFile': {
      msg: { kind: 'fs:lfsReadFile', path: '/uscripts/u1/script.js' },
      backend: vi.mocked(usFs.readLfsFile),
      args: ['/uscripts/u1/script.js'],
    },
  }

  beforeEach(() => vi.clearAllMocks())

  it('union 穷尽性闸就位（新增 fs:* 成员而漏登记时 typecheck 先失败）', () => {
    expect(_exhaustive).toBe(true)
  })

  it.each(Object.entries(CASES))('%s → 分发正确', async (kind, c) => {
    c.setup?.()
    const result = await handleFsCommand(c.msg)
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

  it('fs:restoreToCommit 后端 throw → 原样向上抛（由分发层包成 error 信封）', async () => {
    vi.mocked(usGit.restoreToCommit).mockRejectedValueOnce(new Error('历史版本不存在或已损坏'))
    await expect(handleFsCommand({ kind: 'fs:restoreToCommit', uuid: 'u1', oid: 'o1' })).rejects.toThrow(
      '历史版本不存在或已损坏',
    )
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
    { kind: 'fs:ping' },
    { kind: 'fs:read', uuid: 'u1' },
    { kind: 'fs:history', uuid: 'u1' },
    { kind: 'fs:readAt', uuid: 'u1', oid: 'o1' },
    { kind: 'fs:restoreToCommit', uuid: 'u1', oid: 'o1' },
    { kind: 'fs:exportZip', uuids: ['u1'] },
    { kind: 'fs:lfsTree' },
    { kind: 'fs:lfsReadFile', path: '/uscripts/u1/script.js' },
    { kind: 'state:create' },
    { kind: 'state:save', uuid: 'u1', code: CODE },
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

  it('fs:ping 经监听器应答 { ok: true, data: { ready: true } }（SW 就绪探测的判据）', async () => {
    expect(await reply({ kind: 'fs:ping' })).toEqual({ ok: true, data: { ready: true } })
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
    // 注意不能拿 chat:/conv:/ai:/state: 当未知样本——它们都是 offscreen 前缀（会得 error 信封）
    await expect(reply({ kind: 'bogus:whatever' })).resolves.toBeUndefined()
  })
})
