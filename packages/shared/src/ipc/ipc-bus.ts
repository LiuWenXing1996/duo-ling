// IPC 总线的**发送与订阅**原语（各语境通用：SW / offscreen / 扩展页）。
//
// 接收侧（serveIpc 与三个 matcher）不在这里 —— 它要 chrome.runtime.MessageSender 的类型面，
// 而本包 tsconfig 是 `types: []`（零 chrome 类型是铁律）。接收口每个语境只有一个，
// 归宿主入口，见应用侧 src/shared/ipc-bus.ts。
//
// `ipcRequest` / `ipcNotify` 直接压到底层收发原语（runtime-send 已做结构形状抽取），
// 订阅要 onMessage 的 listener 面，同款就地取结构形状。
import type { RuntimeRequest, SwPush } from './extension-ipc'
import type { DataChangedPush } from '../data-broadcast'
import { notifyRuntime, sendRuntime } from '../runtime-send'

export type IpcPush = SwPush | DataChangedPush

/** chrome.runtime.onMessage 的订阅面（本包不吃 chrome 类型，只取用得上的两个方法） */
interface MessagePort {
  addListener(listener: (raw: unknown) => void): void
  removeListener(listener: (raw: unknown) => void): void
}

function messagePort(): MessagePort | null {
  return (
    (globalThis as { chrome?: { runtime?: { onMessage?: MessagePort } } }).chrome?.runtime
      ?.onMessage ?? null
  )
}

/** 发送一条请求并统一解包 { ok, data | error } 信封；失败 reject Error */
export function ipcRequest<T>(request: RuntimeRequest, opts?: { timeoutMs?: number }): Promise<T> {
  // 现由 sendRuntime 承担（回调形态 + lastError 同步读取的样板收拢）；函数别名保持
  // 「发送口只有 ipc* 一个入口」的叙事，实现共用一份。
  const base = sendRuntime<T>(request)
  if (!opts?.timeoutMs) return base
  // 超时兜底：应答方（容器刚被销毁等）永不回调时不能把 promise 挂死
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`IPC 超时（${opts.timeoutMs}ms 无应答）：${request.kind}`)),
      opts.timeoutMs,
    )
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

export function ipcNotify(message: RuntimeRequest | IpcPush): void {
  notifyRuntime(message)
}

/** 订阅推送（按 kind 前缀匹配，如 'chat:' / 'data:'）；返回退订函数 */
export function ipcSubscribe(
  prefix: string,
  callback: (msg: { kind: string }) => void,
): () => void {
  const port = messagePort()
  if (!port) return () => {}
  const listener = (raw: unknown): void => {
    const msg = raw as { kind?: string } | undefined
    if (msg?.kind && typeof msg.kind === 'string' && msg.kind.startsWith(prefix)) {
      callback(msg as { kind: string })
    }
  }
  port.addListener(listener)
  return () => port.removeListener(listener)
}
