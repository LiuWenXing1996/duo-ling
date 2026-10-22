// 协议一致性测试 —— kind 归属唯一性。
//
// RuntimeRequest 的 kind 是可辨识联合（唯一真相源在 `@duoling/shared` 的 ipc/extension-ipc.ts），
// 但「每个 kind 恰被一端处理」是**类型盲区**：
//   · SW 端按 SW_KIND_PREFIXES（background.ts）前缀过滤 + `[K in SwRequest['kind']]` 映射表，
//     typecheck 已保证 handlers 全覆盖；
//   · offscreen 端按 OFFSCREEN_KIND_PREFIXES（offscreen-main.ts）前缀路由 + as 断言。
// 两端应答面的**并集**是否恰好覆盖 kind 全集、有没有 kind「多端都接」或「无人接」，
// 编译器查不出来——由这里的表驱动断言兜住。服务代理（fs 组 / 注册态写侧 / 剪贴板）
// 报文无 kind，不在这套前缀归属里。
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeRequest } from '@duoling/shared'
// 前缀常量从两端入口直接 import（已 export），避免在测试里复写第二份真相源。
// background.ts / offscreen-main.ts 的运行时逻辑都在入口回调 / onMessage 里，import 无副作用
// （defineBackground 只包装不执行；offscreen 的启动自证全部尽力而为 + catch）。
import { SW_KIND_PREFIXES } from './entrypoints/background'
import { OFFSCREEN_KIND_PREFIXES } from './entrypoints/app/offscreen-main'

// offscreen-main 的 import 链会带到 offscreen-document（文件库）：其 lfs 单例是**惰性**建的，
// import 期不碰 indexedDB，故本文件不必再挡重依赖。只需把启动装配换成空实现（见下）。
// 启动装配会真碰 fs/IDB 并起轮询，与本测试无关——其余导出保留真身
vi.mock('@duoling/offscreen-document', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@duoling/offscreen-document')>()),
  startOffscreenHost: vi.fn(),
}))

/** 期望的 kind 归属（side 取值 = 应答端）。真相源：extension-ipc.ts 的联合 + 各端入口的路由注释 */
type OwnershipRow = { kind: RuntimeRequest['kind']; side: 'sw' | 'offscreen' }

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
  { kind: 'userscript:tabSessions', side: 'sw' },
  { kind: 'userscript:tabTimeline', side: 'sw' },
  { kind: 'userscript:tabActivityEnable', side: 'sw' },
  { kind: 'userscript:tabActivityDisable', side: 'sw' },
  { kind: 'userscript:tabActivityDelete', side: 'sw' },
  { kind: 'userscript:tabActivityClear', side: 'sw' },
  { kind: 'userscript:import', side: 'sw' },
  { kind: 'userscript:importText', side: 'sw' },
  { kind: 'userscript:builtins', side: 'sw' },
  { kind: 'userscript:runlog', side: 'sw' },
  { kind: 'userscript:groups', side: 'sw' },
  { kind: 'userscript:setGroup', side: 'sw' },
  { kind: 'userscript:group-create', side: 'sw' },
  { kind: 'userscript:group-rename', side: 'sw' },
  { kind: 'userscript:group-remove', side: 'sw' },
  { kind: 'userscript:group-reorder', side: 'sw' },
  // —— offscreen:*（SW：容器管理）——

  { kind: 'offscreen:ensure', side: 'sw' },
  { kind: 'offscreen:close', side: 'sw' },
  { kind: 'offscreen:status', side: 'sw' },

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

const _linkEventIsNotRequest: Expect<
  'offscreen:configChanged' extends RuntimeRequest['kind'] ? false : true
> = true

// 上面两个是编译期断言（右侧类型非 true 即 typecheck 失败），这里用真断言消费掉，
// 避免被 noUnusedLocals 判死；顺带在运行时也留一道护栏
it('kind 面完整性断言恒真（编译期 + 运行时双兜底）', () => {
  expect(_allKindsCovered).toBe(true)
  expect(_linkEventIsNotRequest).toBe(true)
})

describe('(a) RuntimeRequest kind 归属唯一性', () => {
  it.each(ALL_KINDS)('$kind → $side', ({ kind, side }) => {
    const swHandled = SW_KIND_PREFIXES.some((p) => kind.startsWith(p))
    const offHandled = OFFSCREEN_KIND_PREFIXES.some((p) => kind.startsWith(p))
    // 核心：恰被一端接——「两端都接」会抢答（sendResponse 只有一次机会），
    // 「无人接」则静默无响应，调用方拿到 port closed
    expect([swHandled, offHandled].filter(Boolean)).toHaveLength(1)
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
