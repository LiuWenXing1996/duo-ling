// SW 侧保活应答：认领一条 kind，回一个固定值。
//
// 保活的真实效果来自「这条消息**到达** SW」本身 —— sendMessage 一到达就重置 SW 的
// 30s 空闲计时。应答值没有任何消费者；回它只是让这次往返完整，发送侧不必每跳都
// 落进 catch（见 @duoling/offscreen-document 的 keepalive）。
//
// 无状态、不缓存：一次构造、反复问询。
import { IPC_SW_KEEPALIVE } from '@duoling/messaging'

/** 宿主总线的问询式 handler：认领的 kind 返回应答值，不认领则让路（总线继续路由） */
export interface KeepaliveHandlers {
  owns(kind: string): boolean
  handle(
    msg: { kind?: string },
    sender: chrome.runtime.MessageSender,
  ): Promise<unknown>
}

export function keepaliveHandler(): KeepaliveHandlers {
  return {
    owns: (kind) => kind === IPC_SW_KEEPALIVE,
    handle: () => Promise.resolve({ alive: true }),
  }
}
