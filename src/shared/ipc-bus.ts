// IPC 总线的**接收侧**：每语境唯一的 onMessage 监听器 + 三种 matcher。
//
// 为什么接收侧留在应用层而发送侧在契约包：matcher 的 handle 收
// chrome.runtime.MessageSender —— 那是 chrome 的类型面，而契约包 tsconfig 是 `types: []`
// （零 chrome 类型，避免 SW 误用 node / 页面误用 chrome 那类错配被类型系统放过）。
// 发送与订阅（ipcRequest / ipcNotify / ipcSubscribe）在 @duoling/shared 的 ipc/ipc-bus。
//
// 接收侧的问询顺序：matcher 数组依次问询，第一个认领的应答（sendResponse 一条消息只有
// 一次机会，多端都接会抢答）。包自管的 kind（管理面只读四条）以 pack matcher 形式插在
// 最前，归各包应答 —— 宿主前缀路由不得抢答；其余 kind 归宿主前缀表
// （SW_KIND_PREFIXES / OFFSCREEN_KIND_PREFIXES）。
import type { RuntimeRequest, IpcPush } from '@duoling/shared'
import { errorText } from '@duoling/shared'

export type { IpcPush }

/** 接收侧的单条路由：owns 认领 → handle 执行（应答值由总线包进统一信封） */
export interface IpcMatcher {
  owns(kind: string): boolean
  handle(msg: RuntimeRequest, sender: chrome.runtime.MessageSender): Promise<unknown>
}

/**
 * 接收口：挂本语境命令面**唯一**的 onMessage 监听器（幂等性由调用点保证 —— 入口顶层只调一次）。
 *
 * 问询顺序 = matchers 数组顺序；第一个 owns 命中的执行并回统一信封。旁听推送
 * （observe）在问询前执行：观察方对响应本就尽力而为，不影响后续路由。
 */
export function serveIpc(opts: {
  matchers: IpcMatcher[]
  /** 旁听推送（SW 旁听 chat:running/finished；offscreen 收 offscreen:configChanged 回拉） */
  observe?: (msg: { kind: string }) => void
}): void {
  chrome.runtime.onMessage.addListener((raw, sender, sendResponse): boolean => {
    const msg = raw as RuntimeRequest | undefined
    if (!msg?.kind || typeof msg.kind !== 'string') return false
    opts.observe?.(msg as { kind: string })
    for (const matcher of opts.matchers) {
      if (!matcher.owns(msg.kind)) continue
      void (async () => {
        try {
          sendResponse({ ok: true, data: await matcher.handle(msg, sender) })
        } catch (e) {
          sendResponse({ ok: false, error: errorText(e) })
        }
      })()
      return true // 异步应答：保留消息通道
    }
    return false // 无人认领：静默让路（可能归另一端或宿主自管面）
  })
}

/** 查表命中的处理器（总线契约的宽入参形态） */
type Handler = (msg: RuntimeRequest, sender: chrome.runtime.MessageSender) => Promise<unknown>

/**
 * 前缀表 matcher：owns 按前缀白名单判定，handle 按表查处理器。
 *
 * 表的键收两种写法（各自的组织粒度不同，不必为「查得到」把其中一方摊平）：
 *   · 完整 kind —— 逐条登记，一个 kind 一个处理器（SW 侧的表）；
 *   · kind 前缀 —— 按域分组，一个域一个穷尽分发的处理器（offscreen 的 'fs:' / 'conv:'）。
 * 查找：完整 kind 命中优先，否则取**最长**匹配前缀。都查不到 = 前缀认领了却没有实现，
 * 报「未知消息类型」而非静默 undefined。
 *
 * handlers 的 msg 参数位写成 never：各表按 kind 收窄了 msg 类型（如
 * `(msg: { kind: 'tab:identify' }, sender) => …`），函数参数逆变检查下只有 never 收得下全部；
 * 查表后按总线契约回宽类型再调用。
 */
export function prefixMatcher(
  prefixes: readonly string[],
  handlers: Record<string, (msg: never, sender: chrome.runtime.MessageSender) => Promise<unknown>>,
): IpcMatcher {
  const table = handlers as Record<string, Handler>
  return {
    owns(kind) {
      return prefixes.some((p) => kind.startsWith(p))
    },
    async handle(msg, sender) {
      const handler = table[msg.kind] ?? prefixKeyed(table, msg.kind)
      if (!handler) throw new Error(`未知消息类型：${msg.kind}`)
      return handler(msg, sender)
    },
  }
}

/** 表里以 kind 前缀为键的那一格（多格命中取最长；表按完整 kind 登记时恒无命中） */
function prefixKeyed(table: Record<string, Handler>, kind: string): Handler | undefined {
  let hit: string | undefined
  for (const key of Object.keys(table)) {
    if (!kind.startsWith(key)) continue
    if (hit === undefined || key.length > hit.length) hit = key
  }
  return hit === undefined ? undefined : table[hit]
}

/** 问询式 pack matcher（GM 运行时包的命令面：owns/handle 由包导出） */
export function packMatcher(pack: {
  owns(kind: string): boolean
  handle(msg: { kind?: string }, sender: chrome.runtime.MessageSender): Promise<unknown>
}): IpcMatcher {
  return {
    owns: (kind) => pack.owns(kind),
    handle: (msg, sender) => pack.handle(msg, sender),
  }
}
