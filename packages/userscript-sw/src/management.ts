// 运行时包自身的 IPC 命令面（handler pack）：保活应答 + 管理面只读四条。
//
// 为什么收在这里：这些命令的应答只依赖本包与 core（读状态库 / 引擎可用性检测），
// 不需要任何宿主自有机器（fs+git 持久化 / offscreen 转发 / 观测库都是宿主的）——
// 谁接入本包，这四条管理命令就随包可用，宿主不必自己实现。
//
// 接线方式（标准化信道）：宿主的总线收口（每语境唯一的 onMessage 监听器）先问本
// handler 认不认领这条消息，认领才执行；不认领继续走宿主自己的前缀路由。本包**不
// 自挂 onMessage 监听**——宿主只保留一个监听器，功能侧不再各造通信。
//
// 覆盖面（刻意只读）：list / getProject / groups / availability。其余 userscript:*
// 命令（save / toggle / import / tabActivity…）押着宿主机器（offscreen 单写方、
// 重注册引擎、观测库），handler 留在宿主侧，不假装通用。
import { IPC_SW_KEEPALIVE } from '@duoling/shared'
import { listSummaries, readAllGroups, readAllProjects, readProject } from '@duoling/userscript-core'
import { getUserScriptsStatus } from './registration'

/** 本包认领的命令 kind（宿主总线的优先问询面；全部只读 + 保活） */
const OWNED_KINDS = [
  IPC_SW_KEEPALIVE,
  'userscript:list',
  'userscript:getProject',
  'userscript:groups',
  'userscript:availability',
] as const

/** 宿主总线的问询式 handler：认领的 kind 返回应答值，不认领返回 undefined（总线继续路由） */
export interface SwIpcHandlers {
  /** 是否认领该 kind（白名单命中 = 本包应答，宿主前缀路由不再参与） */
  owns(kind: string): boolean
  /** 执行（仅对 owns 的 kind 调用；应答值由宿主总线包进统一信封） */
  handle(
    msg: { kind?: string },
    sender: chrome.runtime.MessageSender,
  ): Promise<unknown>
}

/** 一次构造、反复问询（无状态：应答只读库与检测，不缓存） */
export function swIpcHandlers(): SwIpcHandlers {
  return {
    owns(kind) {
      return (OWNED_KINDS as readonly string[]).includes(kind)
    },
    handle(msg, _sender) {
      switch (msg?.kind) {
        case IPC_SW_KEEPALIVE:
          // 保活应答：只证明「SW 活着」并重置空闲计时，不做任何检测
          return Promise.resolve({ alive: true })
        case 'userscript:list':
          return readAllProjects().then(listSummaries)
        case 'userscript:getProject':
          return readProject((msg as { uuid: string }).uuid)
        case 'userscript:groups':
          return readAllGroups()
        case 'userscript:availability':
          return getUserScriptsStatus()
        default:
          // owns 已把非白名单 kind 挡在门外；走到这里属编程错误，抛错让总线回信封
          throw new Error(`未知消息类型：${String(msg?.kind)}`)
      }
    },
  }
}

// OWNED_KINDS 供测试与宿主诊断透出（运行时不消费；导出防「白名单与 switch 漂移」的静默劣化）。
// 类型保留字面量联合：宿主据此把与本端前缀表重叠的 kind 从自管类型里摘掉（只给 string[] 会摘成空集）
export const SW_IPC_OWNED_KINDS: readonly (typeof OWNED_KINDS)[number][] = OWNED_KINDS
