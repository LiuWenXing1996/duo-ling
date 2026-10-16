// SW 保活心跳（offscreen 宿主职责，包内原语）。
//
// 为什么归包：GM 运行时的消息链路预设 SW 常驻 —— GM XHR 的进度帧 / GM_download 结局 /
// 通知点击回调都靠 Port 从 SW 推，SW 空闲 30s 被回收会让在途操作断路（重连也补不回响应）。
// 保活是包正常工作的前置条件，不是宿主的可选装饰（上游 Violentmonkey #45 同款做法）。
//
// 分工：心跳**只重置 SW 的 30s 空闲计时**（sendMessage 一条），不做任何检测；检测由
// SW 侧自管（宿主扩展在 SW 里跑自己的可用性轮询）。SW 侧应答由 sw 包的 handler pack
// 提供（management.ts，宿主总线注册，对 ping 回 { alive: true }）。
//
// 无条件保活：接线即常驻 ping，不设条件门。offscreen document 常驻（不自关，容器管理是
// 宿主的职责，见宿主侧 offscreen 容器 ensure），故心跳随扩展存活全程在线。
//
// 保活 ping 的消息 kind 真相源在 @duoling/shared（ipc.ts 的 IPC_SW_KEEPALIVE）：
// 发送侧（本包）与应答侧（sw 包）分属两个包，字面量放任何一侧都只能靠注释对齐。
// **不得**以宿主已认领的命令前缀开头（如应用侧 IPC 的 `userscript:*`）：宿主路由会先抢答
// 「未知消息类型」，包的应答永远轮不上（sendResponse 一条消息只有一次机会）。独立命名空间
// （`usrt` = user script runtime）保证只有本包的监听器响应。
import { IPC_SW_KEEPALIVE, type KeepaliveMessage } from '@duoling/shared'

/** 保活 ping 的消息 kind（shared 契约的本包别名，维持既有导入面） */
export const SW_KEEPALIVE_KIND = IPC_SW_KEEPALIVE

/** 心跳间隔：SW 空闲回收线是 30s，5s 一跳余量充足 */
export const SW_KEEPALIVE_INTERVAL_MS = 5000

let timer: ReturnType<typeof setInterval> | null = null

async function ping(): Promise<void> {
  // 载荷形状取自 shared 的契约（应答侧 = sw 包的 handler pack 按同一份声明认领）
  const msg: KeepaliveMessage = { kind: SW_KEEPALIVE_KIND }
  try {
    await chrome.runtime.sendMessage(msg)
  } catch {
    // SW 暂未就绪 / 无响应：跳过本周期，下个周期再试
  }
}

/**
 * offscreen 宿主顶层调用（幂等）：启动 SW 保活心跳。
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
