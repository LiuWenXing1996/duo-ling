// 协议一致性测试 —— kind 归属唯一性。
//
// RuntimeRequest 的 kind 是可辨识联合（本文件 = 唯一真相源 src/shared/extension-ipc.ts），
// 但「每个 kind 恰被一端处理」是**类型盲区**：
//   · SW 端按 SW_KIND_PREFIXES（background.ts）前缀过滤 + `[K in SwRequest['kind']]` 映射表，
//     typecheck 已保证 handlers 全覆盖；
//   · offscreen 端按 OFFSCREEN_KIND_PREFIXES（offscreen-main.ts）前缀路由 + as 断言；
//   · host 自管面（GM 运行时 createOffscreenHost 的自有监听器）不走前缀表，按 kind 白名单。
// 三端应答面的**并集**是否恰好覆盖 kind 全集、有没有 kind「多端都接」或「无人接」，
// 编译器查不出来——由这里的表驱动断言兜住。
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeRequest } from '@/shared/extension-ipc'
// 前缀常量从两端入口直接 import（已 export），避免在测试里复写第二份真相源。
// background.ts / offscreen-main.ts 的运行时逻辑都在入口回调 / onMessage 里，import 无副作用
// （defineBackground 只包装不执行；offscreen 的启动自证全部尽力而为 + catch）。
import { SW_KIND_PREFIXES } from '@/entrypoints/background'
import { OFFSCREEN_KIND_PREFIXES } from '@/entrypoints/app/offscreen-main'

// offscreen-main 的 import 链会带到 us-fs / us-git
// （us-fs 模块顶层 new LightningFS，Node 下无 indexedDB 会产生未处理 rejection）——
// 这里只做前缀比对，把这些重依赖挡在 mock 层。
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
// 启动对账会在 import 期真碰 fs/IDB，与本测试无关——保留其余真实导出
vi.mock('@/lib/userscripts/offscreen-state-commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/userscripts/offscreen-state-commands')>()
  return { ...actual, reconcileFs: vi.fn(async () => {}) }
})

/** 期望的 kind 归属（side 取值 = 应答端）。真相源：extension-ipc.ts 的联合 + 各端入口的路由注释 */
type OwnershipRow = { kind: RuntimeRequest['kind']; side: 'sw' | 'offscreen' | 'host' }

// host 自管命令面：GM 运行时 offscreen 包（@duoling/userscript-offscreen）应答，
// 不走 offscreen 前缀表（kind 真相源：@duoling/shared 的 ipc.ts）
const HOST_OWNED_KINDS = ['clipboard:write'] as const

const ALL_KINDS = [
  // —— userscript:*（SW 语境）——
  // 其中 list / getProject / groups / availability 由 sw 包的 handler pack 应答（总线问询的
  // 首位，见 ipc-bus 的 serveIpc），归口仍在 SW，故 side 记 sw；它们在背景页的类型表里已从
  // 前缀推导中摘出，重复登记会被 typecheck 拒。
  { kind: 'userscript:list', side: 'sw' },
  { kind: 'userscript:getProject', side: 'sw' },
  { kind: 'userscript:save', side: 'sw' },
  { kind: 'userscript:create', side: 'sw' },
  { kind: 'userscript:createProject', side: 'sw' },
  { kind: 'userscript:remove', side: 'sw' },
  { kind: 'userscript:removeAll', side: 'sw' },
  { kind: 'userscript:toggle', side: 'sw' },
  { kind: 'userscript:rename', side: 'sw' },
  { kind: 'userscript:availability', side: 'sw' },
  { kind: 'userscript:runlog', side: 'sw' },
  { kind: 'userscript:tabSessions', side: 'sw' },
  { kind: 'userscript:tabTimeline', side: 'sw' },
  { kind: 'userscript:tabActivityEnable', side: 'sw' },
  { kind: 'userscript:tabActivityDisable', side: 'sw' },
  { kind: 'userscript:tabActivityDelete', side: 'sw' },
  { kind: 'userscript:tabActivityClear', side: 'sw' },
  { kind: 'userscript:runEvents', side: 'sw' },
  { kind: 'userscript:errorRead', side: 'sw' },
  { kind: 'userscript:import', side: 'sw' },
  { kind: 'userscript:importText', side: 'sw' },
  { kind: 'userscript:builtins', side: 'sw' },
  // 页面录制（tab-record）：采样落在 duoling-runtime 的 tab_events，写读都归 SW
  { kind: 'userscript:tabRecordRead', side: 'sw' },
  { kind: 'userscript:groups', side: 'sw' },
  { kind: 'userscript:setGroup', side: 'sw' },
  { kind: 'userscript:group-create', side: 'sw' },
  { kind: 'userscript:group-rename', side: 'sw' },
  { kind: 'userscript:group-remove', side: 'sw' },
  { kind: 'userscript:group-reorder', side: 'sw' },
  // —— fs:*（offscreen：源码库 duoling-fs 命令面，SW 静默让路）——
  { kind: 'fs:ping', side: 'offscreen' },
  { kind: 'fs:read', side: 'offscreen' },
  { kind: 'fs:history', side: 'offscreen' },
  { kind: 'fs:readAt', side: 'offscreen' },
  { kind: 'fs:restoreToCommit', side: 'offscreen' },
  { kind: 'fs:exportZip', side: 'offscreen' },
  { kind: 'fs:lfsTree', side: 'offscreen' },
  { kind: 'fs:lfsReadFile', side: 'offscreen' },
  // 对话资源库（/assets，与 /uscripts 平级；同样是 lfs 库，故同宿主）
  { kind: 'fs:assetPut', side: 'offscreen' },
  { kind: 'fs:assetRead', side: 'offscreen' },
  // —— state:*（offscreen：项目状态库写侧，单写方）——
  { kind: 'state:create', side: 'offscreen' },
  { kind: 'state:createProject', side: 'offscreen' },
  { kind: 'state:save', side: 'offscreen' },
  { kind: 'state:remove', side: 'offscreen' },
  { kind: 'state:removeAll', side: 'offscreen' },
  { kind: 'state:toggle', side: 'offscreen' },
  { kind: 'state:rename', side: 'offscreen' },
  { kind: 'state:import', side: 'offscreen' },
  { kind: 'state:import-text', side: 'offscreen' },
  { kind: 'state:group-create', side: 'offscreen' },
  { kind: 'state:group-rename', side: 'offscreen' },
  { kind: 'state:group-remove', side: 'offscreen' },
  { kind: 'state:group-reorder', side: 'offscreen' },
  { kind: 'state:set-group', side: 'offscreen' },
  // —— offscreen:*（SW：容器管理）——
  { kind: 'offscreen:ensure', side: 'sw' },
  { kind: 'offscreen:close', side: 'sw' },
  { kind: 'offscreen:status', side: 'sw' },
  { kind: 'offscreen:ready', side: 'sw' },
  // —— clipboard:*（host：GM 运行时 createOffscreenHost 自管，免手势 + 富文本）——
  { kind: 'clipboard:write', side: 'host' },
  // —— model:*（SW：配置中转）——
  { kind: 'model:getActiveProfile', side: 'sw' },
  // —— page:*（SW：AI 工具支路 page_snapshot / page_env_read 经 SW 向页面里的页面检查器下发指令；
  // 后两条供 popup 的页面概览）——
  { kind: 'page:snapshot', side: 'sw' },
  { kind: 'page:env', side: 'sw' },
  { kind: 'page:overview', side: 'sw' },
  // —— picker:*（SW：浮层发起的拾取 —— 指令下发给页面里的常驻件，结果按 reqId 配对）——
  { kind: 'picker:pick', side: 'sw' },
  { kind: 'picker:cancel', side: 'sw' },
  // —— float:*（SW：浮层宿主命令面 —— 命令经 float-bridge 下发 DL Port 事件帧给宿主件）——
  { kind: 'float:open', side: 'sw' },
  { kind: 'float:collapse', side: 'sw' },
  { kind: 'float:busy', side: 'sw' },
  { kind: 'float:ping', side: 'sw' },
  // —— tab:*（SW：浮层自证身份，回 sender.tab.id 供浮层认定会话归属）——
  { kind: 'tab:identify', side: 'sw' },
  // —— conv:*（offscreen：会话写侧，唯一写方；SW 对前缀静默让路）——
  { kind: 'conv:create', side: 'offscreen' },
  { kind: 'conv:rename', side: 'offscreen' },
  { kind: 'conv:delete', side: 'offscreen' },
  { kind: 'conv:deleteAll', side: 'offscreen' },
  // —— chat:*（offscreen：对话编排，发起 / 停止 / 重连 / 孤儿）——
  { kind: 'chat:start', side: 'offscreen' },
  { kind: 'chat:abort', side: 'offscreen' },
  { kind: 'chat:resume', side: 'offscreen' },
  { kind: 'chat:orphans', side: 'offscreen' },
  { kind: 'chat:orphanAction', side: 'offscreen' },
  // —— sw:*（SW：内存态 + 自证）——
  { kind: 'sw:runningChats', side: 'sw' },
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

// 上面两个是编译期断言（右侧类型非 true 即 typecheck 失败），这里用真断言消费掉，
// 避免被 noUnusedLocals 判死；顺带在运行时也留一道护栏
it('kind 面完整性断言恒真（编译期 + 运行时双兜底）', () => {
  expect(_allKindsCovered).toBe(true)
  expect(_pushIsNotRequest).toBe(true)
})

describe('(a) RuntimeRequest kind 归属唯一性', () => {
  it.each(ALL_KINDS)('$kind → $side', ({ kind, side }) => {
    const swHandled = SW_KIND_PREFIXES.some((p) => kind.startsWith(p))
    const offHandled = OFFSCREEN_KIND_PREFIXES.some((p) => kind.startsWith(p))
    const hostHandled = (HOST_OWNED_KINDS as readonly string[]).includes(kind)
    // 核心：恰被一端接——「多端都接」会抢答（sendResponse 只有一次机会），
    // 「无人接」则静默无响应，调用方拿到 port closed
    expect([swHandled, offHandled, hostHandled].filter(Boolean)).toHaveLength(1)
    expect(side === 'sw' ? swHandled : side === 'offscreen' ? offHandled : hostHandled).toBe(true)
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
        OFFSCREEN_KIND_PREFIXES.some((p) => kind.startsWith(p)) ||
        (HOST_OWNED_KINDS as readonly string[]).includes(kind)
      expect(covered, kind).toBe(true)
    }
  })

  it('保活心跳 kind（background:keepalive）不落在任何宿主认领前缀内 —— 应答归包，宿主路由不得抢答', async () => {
    const { IPC_SW_KEEPALIVE } = await import('@duoling/messaging')
    expect(SW_KIND_PREFIXES.some((p) => IPC_SW_KEEPALIVE.startsWith(p))).toBe(false)
    expect(OFFSCREEN_KIND_PREFIXES.some((p) => IPC_SW_KEEPALIVE.startsWith(p))).toBe(false)
  })
})
