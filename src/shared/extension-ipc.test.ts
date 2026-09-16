// 协议一致性测试（层 2，docs/testing-plan.md）—— kind 归属唯一性。
//
// RuntimeRequest 的 kind 是可辨识联合（本文件 = 唯一真相源 src/shared/extension-ipc.ts），
// 但「每个 kind 恰被一端处理」是**类型盲区**：
//   · SW 端按 SW_KIND_PREFIXES（background.ts）前缀过滤 + `[K in SwRequest['kind']]` 映射表，
//     typecheck 已保证 handlers 全覆盖；
//   · offscreen 端按 OFFSCREEN_KIND_PREFIXES（offscreen-main.ts）前缀路由 + as 断言。
// 两端前缀的**并集**是否恰好覆盖 kind 全集、有没有 kind「两边都接」或「两边都不接」，
// 编译器查不出来——由这里的表驱动断言兜住。
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeRequest } from '@/shared/extension-ipc'
// 前缀常量从两端入口直接 import（已 export），避免在测试里复写第二份真相源。
// background.ts / offscreen-main.ts 的运行时逻辑都在入口回调 / onMessage 里，import 无副作用
// （defineBackground 只包装不执行；offscreen 的启动自证全部尽力而为 + catch）。
import { SW_KIND_PREFIXES } from '@/entrypoints/background'
import { OFFSCREEN_KIND_PREFIXES } from '@/entrypoints/app/offscreen-main'

// offscreen-main 的 import 链会带到 builder（esbuild-wasm，纯重不纯用）与 us-fs / us-git
// （us-fs 模块顶层 new LightningFS，Node 下无 indexedDB 会产生未处理 rejection）——
// 这里只做前缀比对，把这些重依赖挡在 mock 层。
vi.mock('@/lib/userscripts/builder', () => ({
  buildProject: vi.fn(),
  BuildError: class BuildError extends Error {},
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
// 启动对账会在 import 期真碰 fs/IDB，与本测试无关——保留其余真实导出
vi.mock('@/lib/userscripts/offscreen-state-commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/userscripts/offscreen-state-commands')>()
  return { ...actual, reconcileFs: vi.fn(async () => {}) }
})

/** 期望的 kind 归属（side 取值 = 应答端）。真相源：extension-ipc.ts 的联合 + 两端入口的路由注释 */
type OwnershipRow = { kind: RuntimeRequest['kind']; side: 'sw' | 'offscreen' }

const ALL_KINDS = [
  // —— userscript:*（SW）——
  { kind: 'userscript:list', side: 'sw' },
  { kind: 'userscript:getProject', side: 'sw' },
  { kind: 'userscript:updateFiles', side: 'sw' },
  { kind: 'userscript:clearDeprecated', side: 'sw' },
  { kind: 'userscript:create', side: 'sw' },
  { kind: 'userscript:createProject', side: 'sw' },
  { kind: 'userscript:remove', side: 'sw' },
  { kind: 'userscript:toggle', side: 'sw' },
  { kind: 'userscript:availability', side: 'sw' },
  { kind: 'userscript:errors', side: 'sw' },
  { kind: 'userscript:clearErrors', side: 'sw' },
  { kind: 'userscript:import', side: 'sw' },
  // —— ai:*（offscreen：git 历史侧车 + 构建宿主）——
  { kind: 'ai:ping', side: 'offscreen' },
  { kind: 'ai:history', side: 'offscreen' },
  { kind: 'ai:historyTree', side: 'offscreen' },
  { kind: 'ai:restoreToCommit', side: 'offscreen' },
  { kind: 'ai:lfsTree', side: 'offscreen' },
  { kind: 'ai:build', side: 'offscreen' },
  { kind: 'ai:writeDraft', side: 'offscreen' },
  { kind: 'ai:readDraft', side: 'offscreen' },
  { kind: 'ai:lfsReadFile', side: 'offscreen' },
  // —— state:*（offscreen：项目状态库写侧，单写方）——
  { kind: 'state:create', side: 'offscreen' },
  { kind: 'state:createProject', side: 'offscreen' },
  { kind: 'state:updateFiles', side: 'offscreen' },
  { kind: 'state:remove', side: 'offscreen' },
  { kind: 'state:toggle', side: 'offscreen' },
  { kind: 'state:import', side: 'offscreen' },
  // —— offscreen:*（SW：容器管理）——
  { kind: 'offscreen:ensure', side: 'sw' },
  { kind: 'offscreen:close', side: 'sw' },
  { kind: 'offscreen:status', side: 'sw' },
  { kind: 'offscreen:ready', side: 'sw' },
  // —— model:*（SW：配置中转）——
  { kind: 'model:getActiveProfile', side: 'sw' },
  // —— page:*（SW：AI 工具支路，page_snapshot 经 SW 调 userScripts.execute）——
  { kind: 'page:snapshot', side: 'sw' },
  // —— conv:*（offscreen：会话写侧，唯一写方；SW 对前缀静默让路）——
  { kind: 'conv:create', side: 'offscreen' },
  { kind: 'conv:rename', side: 'offscreen' },
  { kind: 'conv:delete', side: 'offscreen' },
  { kind: 'conv:deleteAll', side: 'offscreen' },
  { kind: 'conv:append', side: 'offscreen' },
  // —— chat:*（offscreen：对话编排，发起 / 停止 / 重连 / 孤儿）——
  { kind: 'chat:start', side: 'offscreen' },
  { kind: 'chat:abort', side: 'offscreen' },
  { kind: 'chat:resume', side: 'offscreen' },
  { kind: 'chat:orphans', side: 'offscreen' },
  { kind: 'chat:orphanAction', side: 'offscreen' },
  // —— sw:*（SW：自证）——
  { kind: 'sw:buildInfo', side: 'sw' },
] as const satisfies readonly OwnershipRow[]

type Expect<T extends true> = T

// —— 类型层兜底（typecheck 阶段就报错，比运行时更早）——
// RuntimeRequest 新增/删除 kind 而上表未同步 → 这里非 never → typecheck 失败
const _allKindsCovered: Expect<
  Exclude<RuntimeRequest['kind'], (typeof ALL_KINDS)[number]['kind']> extends never ? true : false
> = true
// OffscreenPush 是 SW→offscreen 的单向推送，不进请求命令面（不属于任何一端的 handlers）
const _pushIsNotRequest: Expect<'offscreen:configChanged' extends RuntimeRequest['kind'] ? false : true> = true

describe('(a) RuntimeRequest kind 归属唯一性', () => {
  it.each(ALL_KINDS)('$kind → $side', ({ kind, side }) => {
    const swHandled = SW_KIND_PREFIXES.some((p) => kind.startsWith(p))
    const offHandled = OFFSCREEN_KIND_PREFIXES.some((p) => kind.startsWith(p))
    // 核心：恰被一端接——「两边都接」会抢答（sendResponse 只有一次机会），
    // 「两边都不接」则静默无响应，调用方拿到 port closed
    expect(swHandled).not.toBe(offHandled)
    expect(side === 'sw' ? swHandled : offHandled).toBe(true)
  })

  it('两端前缀表互不沾边（无共同前缀、互不为对方前缀）', () => {
    for (const sw of SW_KIND_PREFIXES) {
      for (const off of OFFSCREEN_KIND_PREFIXES) {
        expect(sw.startsWith(off)).toBe(false)
        expect(off.startsWith(sw)).toBe(false)
      }
    }
  })

  it('前缀并集覆盖表内全部 kind（无 kind 落在路由盲区）', () => {
    for (const { kind } of ALL_KINDS) {
      const covered =
        SW_KIND_PREFIXES.some((p) => kind.startsWith(p)) ||
        OFFSCREEN_KIND_PREFIXES.some((p) => kind.startsWith(p))
      expect(covered, kind).toBe(true)
    }
  })
})
