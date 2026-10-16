// SW 保活心跳（offscreen → SW，本包发送端）。
//
// 为什么需要：SW 空闲 30s 即被回收，而「在途操作」全押在它常驻上 —— GM XHR 的进度帧 /
// GM_download 结局 / 通知点击回调都靠 Port 从 SW 推，回收即断路（重连也补不回响应）。
// 故保活是前置条件，不是可选装饰（上游 Violentmonkey #45 同款做法）。
//
// 分工：心跳**只重置 SW 的 30s 空闲计时**（sendMessage 一条），不做任何检测；检测归
// 消费方自管（宿主在 SW 里跑自己的可用性轮询）。应答侧在 @duoling/service-worker。
//
// 启动点归宿主：本包只提供原语，offscreen 入口顶层调一次即全程在线（幂等、无 chrome 即 no-op）。
//
// kind 契约在 @duoling/messaging —— 发送侧（本包）与应答侧分属两包，字面量放任何一侧都只能
// 靠注释对齐。该 kind **不得**落在宿主已认领的命令前缀内（如应用侧 IPC 的 `userscript:*`）：
// 宿主路由会先抢答「未知消息类型」，应答永远轮不上（sendResponse 一条消息只有一次机会）。
import { IPC_SW_KEEPALIVE, type KeepaliveMessage } from '@duoling/messaging'

/** 心跳间隔：SW 空闲回收线是 30s，5s 一跳余量充足 */
export const SW_KEEPALIVE_INTERVAL_MS = 5000

let timer: ReturnType<typeof setInterval> | null = null

async function ping(): Promise<void> {
  // 载荷形状取自 messaging 的契约（应答侧按同一份声明认领）
  const msg: KeepaliveMessage = { kind: IPC_SW_KEEPALIVE }
  try {
    await chrome.runtime.sendMessage(msg)
  } catch {
    // SW 暂未就绪 / 无响应：跳过本周期，下个周期再试
  }
}

/**
 * 宿主入口顶层调用（幂等）：启动 SW 保活心跳。
 * 无 chrome 环境（Node 单测）为 no-op；重复调用只保留第一个定时器。
 */
export function startSwKeepalive(intervalMs = SW_KEEPALIVE_INTERVAL_MS): void {
  if (timer || typeof chrome === 'undefined') return
  void ping()
  // node 环境的定时器句柄带 unref（不阻止进程退出，vitest worker 不被挂住）；浏览器端是 number，无此方法
  const handle = setInterval(() => void ping(), intervalMs) as unknown as { unref?: () => void }
  handle.unref?.()
  timer = handle as unknown as ReturnType<typeof setInterval>
}

/** 测试与显式复位用：停掉心跳（生产路径不调 —— 心跳与 offscreen 容器同生命周期） */
export function stopSwKeepalive(): void {
  if (timer === null) return
  clearInterval(timer as unknown as Parameters<typeof clearInterval>[0])
  timer = null
}
