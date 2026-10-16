// 标准化 IPC 总线：功能侧不直接调 chrome.runtime 的收发原语，一律走这里。
//
// 三类原语，各语境只此一份：
//   · 发送 —— ipcRequest（请求-应答，统一信封解包）与 ipcNotify（单向推送，尽力而为）；
//   · 订阅 —— ipcSubscribe（按 kind 前缀收推送：chat:chunk / data:changed / availabilityChanged…）；
//   · 接收 —— serveIpc（每语境**唯一**的 onMessage 监听器，入口在 defineBackground /
//     offscreen 入口各调一次）。功能代码只写 handler 与 matcher，永不摸 addListener。
//
// 接收侧的问询顺序：matcher 数组依次问询，第一个认领的应答（sendResponse 一条消息只有
// 一次机会，多端都接会抢答）。运行时包（@duoling/userscript-sw / -offscreen）的命令面
// 以 pack matcher 形式插在最前 —— 包自管的 kind（保活 / 剪贴板 / 管理面只读四条）归包，
// 宿主前缀路由不得抢答；其余 kind 归宿主前缀表（SW_KIND_PREFIXES / OFFSCREEN_KIND_PREFIXES）。
import type { OffscreenPush, RuntimeRequest, SwPush } from './extension-ipc'
import type { DataChangedPush } from '@duoling/shared'
import { runtimeSend } from './runtime-send'
import { errorText } from '@/lib/format'

/** 接收侧的单条路由：owns 认领 → handle 执行（应答值由总线包进统一信封） */
export interface IpcMatcher {
  owns(kind: string): boolean
  handle(msg: RuntimeRequest, sender: chrome.runtime.MessageSender): Promise<unknown>
}

/** 单向推送的载荷：命令面之外的三种（offcreen 推送 / SW 广播 / 数据变更广播） */
export type IpcPush = OffscreenPush | SwPush | DataChangedPush

/** 发送一条请求并统一解包 { ok, data | error } 信封；失败 reject Error */
export function ipcRequest<T>(request: RuntimeRequest, opts?: { timeoutMs?: number }): Promise<T> {
  // 现由 runtimeSend 承担（回调形态 + lastError 同步读取的样板收拢）；函数别名保持
  // 「发送口只有 ipc* 一个入口」的叙事，实现共用一份。
  const base = runtimeSend<T>(request)
  if (!opts?.timeoutMs) return base
  // 超时兜底：应答方（容器刚被销毁等）永不回调时不能把 promise 挂死
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`IPC 超时（${opts.timeoutMs}ms 无应答）：${request.kind}`)), opts.timeoutMs)
    base.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** 单向推送（尽力而为）：无人接收不是错误，静默吞掉（offscreen:ready / chat:chunk 这类） */
export function ipcNotify(message: RuntimeRequest | IpcPush): void {
  try {
    void chrome.runtime.sendMessage(message).catch(() => {})
  } catch {
    // chrome.runtime 不在（纯 Node 测试环境等）：推送本就尽力而为
  }
}

/** 订阅推送（按 kind 前缀匹配，如 'chat:' / 'data:'）；返回退订函数 */
export function ipcSubscribe(prefix: string, callback: (msg: { kind: string }) => void): () => void {
  const listener = (raw: unknown): void => {
    const msg = raw as { kind?: string } | undefined
    if (msg?.kind && typeof msg.kind === 'string' && msg.kind.startsWith(prefix)) {
      callback(msg as { kind: string })
    }
  }
  chrome.runtime.onMessage.addListener(listener)
  return () => chrome.runtime.onMessage.removeListener(listener)
}

/**
 * 接收口：挂本语境**唯一**的 onMessage 监听器（幂等性由调用点保证 —— 入口顶层只调一次）。
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
 *   · kind 前缀 —— 按域分组，一个域一个穷尽分发的处理器（offscreen 的 'fs:' / 'state:'）。
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
export function packMatcher(pack: { owns(kind: string): boolean; handle(msg: { kind?: string }, sender: chrome.runtime.MessageSender): Promise<unknown> }): IpcMatcher {
  return {
    owns: (kind) => pack.owns(kind),
    handle: (msg, sender) => pack.handle(msg, sender),
  }
}
