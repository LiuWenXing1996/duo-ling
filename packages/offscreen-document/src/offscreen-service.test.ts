// OffscreenService 的方法齐备与转发面：契约 IOffscreenService 的成员一个都不能漏。
//
// 漏接时编译器不报错（返回 Promise<unknown>，漏接 = 静默 undefined）—— 用「类型层穷尽性
// 校验 + 表驱动派发 + 后端 mock 被触达」三道闸钉死。fs 层与状态库写侧一律 mock：真身落在
// lightning-fs / isomorphic-git / IndexedDB 上，不是本用例的靶心（各由自己的单测负责）。
import type { IOffscreenService } from '@duoling/proxy-service-list'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

vi.mock('./clipboard', () => ({
  writeClipboard: vi.fn(),
}))
vi.mock('./fs/lfs', () => ({
  readLfsFile: vi.fn(),
  readLfsTree: vi.fn(),
}))
vi.mock('./fs/assets', () => ({
  putAsset: vi.fn(),
  readAsset: vi.fn(),
}))
vi.mock('./fs/git', () => ({
  listHistory: vi.fn(),
  readSnapshotAt: vi.fn(),
  readSource: vi.fn(),
  restoreToCommit: vi.fn(),
}))
vi.mock('./userstate/project-write', () => ({
  createGeneratedProject: vi.fn(),
  createGroup: vi.fn(),
  createProject: vi.fn(),
  importScriptFromText: vi.fn(),
  importScriptsZip: vi.fn(),
  removeAllProjects: vi.fn(),
  removeGroupAndReassign: vi.fn(),
  removeProjectAndRepo: vi.fn(),
  renameGroup: vi.fn(),
  renameProject: vi.fn(),
  reorderGroups: vi.fn(),
  saveExisting: vi.fn(),
  setProjectEnabled: vi.fn(),
  setProjectGroup: vi.fn(),
}))
// 广播只换实现：断言「写完广播了 / 写失败不广播」要能数调用，其余 core 导出取真身
vi.mock('@duoling/userscript-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@duoling/userscript-core')>()),
  broadcastDataChange: vi.fn(),
}))

import { broadcastDataChange } from '@duoling/userscript-core'
import * as clipboard from './clipboard'
import * as fsAssets from './fs/assets'
import * as fsGit from './fs/git'
import * as fsLfs from './fs/lfs'
import * as pw from './userstate/project-write'
import { OffscreenService } from './offscreen-service'

const service = new OffscreenService()

type Expect<T extends true> = T

// 方法清单：typecheck 闸——IOffscreenService 新增成员而未实现 → Exclude 非 never → 编译失败
const METHODS = [
  'fsRead',
  'fsHistory',
  'fsReadAt',
  'fsRestoreToCommit',
  'fsExportZip',
  'fsLfsTree',
  'fsLfsReadFile',
  'fsAssetPut',
  'fsAssetRead',
  'clipboardWrite',
  'userscriptCreate',
  'userscriptCreateGenerated',
  'userscriptSave',
  'userscriptRemove',
  'userscriptRemoveAll',
  'userscriptToggle',
  'userscriptRename',
  'userscriptSetGroup',
  'userscriptImportZip',
  'userscriptImportText',
  'userscriptGroupCreate',
  'userscriptGroupRename',
  'userscriptGroupRemove',
  'userscriptGroupReorder',
] as const satisfies readonly (keyof IOffscreenService)[]
const _exhaustive: Expect<
  Exclude<keyof IOffscreenService, (typeof METHODS)[number]> extends never ? true : false
> = true

/** 每条用例：调谁、转发到哪个后端、后端该收到什么、应广播哪几域（顺序也钉） */
interface Case {
  run: () => Promise<unknown>
  backend?: Mock
  args?: unknown[]
  result?: unknown
  setup?: () => void
  /** 期望的广播调用序列（[域, uuid?]）；缺省 = 不该广播 */
  broadcast?: unknown[][]
}

const GEN_PAYLOAD = {
  name: 'AI 脚本',
  config: { matches: ['*://*/*'], allFrames: true, runAt: 'document_end' as const },
  code: 'console.log(1)',
  enabled: false,
  note: 'AI 生成',
}

const CASES: Record<(typeof METHODS)[number], Case> = {
  fsRead: { run: () => service.fsRead('u1'), backend: vi.mocked(fsGit.readSource), args: ['u1'] },
  fsHistory: {
    run: () => service.fsHistory('u1'),
    backend: vi.mocked(fsGit.listHistory),
    args: ['u1'],
  },
  fsReadAt: {
    run: () => service.fsReadAt('u1', 'o1'),
    backend: vi.mocked(fsGit.readSnapshotAt),
    args: ['u1', 'o1'],
  },
  fsRestoreToCommit: {
    run: () => service.fsRestoreToCommit('u1', 'o1'),
    backend: vi.mocked(fsGit.restoreToCommit),
    args: ['u1', 'o1'],
  },
  fsExportZip: {
    // readSource mock 返回 null → source 为 null → 空 payload 走真实 fflate 打包
    run: () => service.fsExportZip(['u1']),
    backend: vi.mocked(fsGit.readSource),
    args: ['u1'],
    setup: () => vi.mocked(fsGit.readSource).mockResolvedValue(null),
  },
  fsLfsTree: { run: () => service.fsLfsTree(), backend: vi.mocked(fsLfs.readLfsTree), args: ['/'] },
  fsLfsReadFile: {
    run: () => service.fsLfsReadFile('/uscripts/u1/script.js'),
    backend: vi.mocked(fsLfs.readLfsFile),
    args: ['/uscripts/u1/script.js'],
  },
  fsAssetPut: {
    // data URL 在实现层就被拆成 (mime, bytes) —— 断言后端收到的是拆好的形状，
    // 而不是把整串 data URL 原样往下传（后者会让 id 的算法依赖调用方）
    run: () => service.fsAssetPut('data:image/png;base64,AAAA', 'shot.png'),
    backend: vi.mocked(fsAssets.putAsset),
    args: [{ filename: 'shot.png', mediaType: 'image/png', bytes: new Uint8Array([0, 0, 0]) }],
  },
  fsAssetRead: {
    run: () => service.fsAssetRead('abc123'),
    backend: vi.mocked(fsAssets.readAsset),
    args: ['abc123'],
    // 资源不在 → 原样回 null（面板据此显示占位而不是报错）
    setup: () => vi.mocked(fsAssets.readAsset).mockResolvedValue(null),
    result: null,
  },

  // —— GM 桥面：载荷原样交给写本体（校验与 DOM 接线在 clipboard.ts 及其单测）——
  clipboardWrite: {
    run: () => service.clipboardWrite({ text: 'x', html: null }),
    backend: vi.mocked(clipboard.writeClipboard),
    args: [{ text: 'x', html: null }],
  },

  // —— 状态库写侧：转发 + 广播（不带 uuid = 整体变化，读侧全量重拉）——
  userscriptCreate: {
    run: () => service.userscriptCreate(),
    backend: vi.mocked(pw.createProject),
    args: [],
    broadcast: [['script']],
  },
  userscriptCreateGenerated: {
    run: () => service.userscriptCreateGenerated(GEN_PAYLOAD),
    backend: vi.mocked(pw.createGeneratedProject),
    args: [GEN_PAYLOAD],
    broadcast: [['script']],
  },
  userscriptSave: {
    run: () => service.userscriptSave('u1', 'code', { name: '新名', note: '备注' }),
    backend: vi.mocked(pw.saveExisting),
    args: ['u1', 'code', { name: '新名', note: '备注' }],
    broadcast: [['script', 'u1']],
  },
  userscriptRemove: {
    run: () => service.userscriptRemove('u1'),
    backend: vi.mocked(pw.removeProjectAndRepo),
    args: ['u1'],
    broadcast: [['script', 'u1']],
  },
  userscriptRemoveAll: {
    run: () => service.userscriptRemoveAll(),
    backend: vi.mocked(pw.removeAllProjects),
    args: [],
    broadcast: [['script']],
  },
  userscriptToggle: {
    run: () => service.userscriptToggle('u1', true),
    backend: vi.mocked(pw.setProjectEnabled),
    args: ['u1', true],
    broadcast: [['script', 'u1']],
  },
  userscriptRename: {
    run: () => service.userscriptRename('u1', '新名'),
    backend: vi.mocked(pw.renameProject),
    args: ['u1', '新名'],
    broadcast: [['script', 'u1']],
  },
  userscriptSetGroup: {
    run: () => service.userscriptSetGroup('u1', 'g1'),
    backend: vi.mocked(pw.setProjectGroup),
    args: ['u1', 'g1'],
    broadcast: [['script', 'u1']],
  },
  userscriptImportZip: {
    run: () => service.userscriptImportZip('emlwLWJ5dGVz'),
    backend: vi.mocked(pw.importScriptsZip),
    args: ['emlwLWJ5dGVz'],
    broadcast: [['script']],
  },
  userscriptImportText: {
    run: () => service.userscriptImportText('console.log(1)'),
    backend: vi.mocked(pw.importScriptFromText),
    args: ['console.log(1)'],
    broadcast: [['script']],
  },
  // 分组写双域：定义变了 + 成员的归属引用可能变了（删分组会把成员退回未分组）
  userscriptGroupCreate: {
    run: () => service.userscriptGroupCreate('购物助手'),
    backend: vi.mocked(pw.createGroup),
    args: ['购物助手'],
    broadcast: [['group'], ['script']],
  },
  userscriptGroupRename: {
    run: () => service.userscriptGroupRename('g1', '新名'),
    backend: vi.mocked(pw.renameGroup),
    args: ['g1', '新名'],
    broadcast: [['group'], ['script']],
  },
  userscriptGroupRemove: {
    run: () => service.userscriptGroupRemove('g1'),
    backend: vi.mocked(pw.removeGroupAndReassign),
    args: ['g1'],
    broadcast: [['group'], ['script']],
  },
  userscriptGroupReorder: {
    run: () => service.userscriptGroupReorder(['g2', 'g1']),
    backend: vi.mocked(pw.reorderGroups),
    args: [['g2', 'g1']],
    broadcast: [['group'], ['script']],
  },
}

beforeEach(() => vi.clearAllMocks())

describe('OffscreenService 方法齐备且转发正确', () => {
  it('方法清单与 IOffscreenService 严丝合缝（漏实现时 typecheck 先失败）', () => {
    expect(_exhaustive).toBe(true)
  })

  it.each(Object.entries(CASES))('%s → 转发对应后端', async (name, c) => {
    c.setup?.()
    const result = await c.run()
    expect(c.backend, `${name} 应触达后端`).toHaveBeenCalledTimes(1)
    expect(c.backend).toHaveBeenCalledWith(...(c.args ?? []))
    if (c.result !== undefined) expect(result).toEqual(c.result)
  })

  it.each(Object.entries(CASES))('%s → 广播域正确（顺序也钉）', async (name, c) => {
    await c.run()
    const calls = vi.mocked(broadcastDataChange).mock.calls
    expect(calls, name).toEqual(c.broadcast ?? [])
  })

  it('fsRestoreToCommit 后端 throw → 原样向上抛（由库侧包成 error）', async () => {
    vi.mocked(fsGit.restoreToCommit).mockRejectedValueOnce(new Error('历史版本不存在或已损坏'))
    await expect(service.fsRestoreToCommit('u1', 'o1')).rejects.toThrow('历史版本不存在或已损坏')
  })

  it('fsExportZip 单脚本命中源码时回 name（打包布局由 fs/zip 的单测守）', async () => {
    vi.mocked(fsGit.readSource).mockResolvedValue({ code: '// ==UserScript==\n// @name 导出示例\n// ==/UserScript==\n' })
    const out = (await service.fsExportZip(['u1'])) as { zipBase64: string; name?: string }
    expect(out.name).toBe('导出示例')
    expect(typeof out.zipBase64).toBe('string')
    expect(out.zipBase64.length).toBeGreaterThan(0)
  })

  it('userscriptSave 原样回传后端的 outcome（notes 不吞）', async () => {
    const outcome = { project: { uuid: 'u1' }, notes: ['@match 不合法已丢弃'] } as never
    vi.mocked(pw.saveExisting).mockResolvedValueOnce(outcome)
    await expect(service.userscriptSave('u1', 'code')).resolves.toBe(outcome)
  })

  it('写失败不广播：写抛错 → 原样向上抛，且一条通知都不发', async () => {
    vi.mocked(pw.createProject).mockRejectedValueOnce(new Error('IDB 打不开'))
    await expect(service.userscriptCreate()).rejects.toThrow('IDB 打不开')
    expect(broadcastDataChange).not.toHaveBeenCalled()
  })
})
