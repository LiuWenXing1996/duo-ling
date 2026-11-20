// IPC 总线的**接收侧**：每语境唯一的 onMessage 监听器 + 三种 matcher（第一个认领的应答）。
// 为什么接收侧留在应用层、问询顺序与 pack matcher 的位置见 docs/adr/0028-ipc-receiver-in-app-layer.md。
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
