// OffscreenService 的方法齐备与转发面：契约 IOffscreenService 的成员一个都不能漏。
//
// 漏接时编译器不报错（返回 Promise<unknown>，漏接 = 静默 undefined）—— 用「类型层穷尽性
// 校验 + 表驱动派发 + 后端 mock 被触达」三道闸钉死。fs 层一律 mock：真身落在 lightning-fs /
// isomorphic-git 上，不是本用例的靶心（那两个由各自的单测与 e2e 负责）。
import type { IOffscreenService } from '@duoling/proxy-service-list'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

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

import * as fsAssets from './fs/assets'
import * as fsGit from './fs/git'
import * as fsLfs from './fs/lfs'
import { OffscreenService } from './offscreen-service'

const service = new OffscreenService()

type Expect<T extends true> = T

// fs 组方法清单：typecheck 闸——IOffscreenService 新增成员而未实现 → Exclude 非 never → 编译失败
const FS_METHODS = [
  'fsRead',
  'fsHistory',
  'fsReadAt',
  'fsRestoreToCommit',
  'fsExportZip',
  'fsLfsTree',
  'fsLfsReadFile',
  'fsAssetPut',
  'fsAssetRead',
] as const satisfies readonly (keyof IOffscreenService)[]
const _exhaustive: Expect<
  Exclude<keyof IOffscreenService, (typeof FS_METHODS)[number]> extends never ? true : false
> = true

const CASES: Record<
  (typeof FS_METHODS)[number],
  { run: () => Promise<unknown>; backend?: Mock; args?: unknown[]; result?: unknown; setup?: () => void }
> = {
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
})
