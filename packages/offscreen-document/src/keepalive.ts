// SW 空闲 30s 即被回收，而在途操作全押在它常驻上（上游 VM 同款做法）。
// 故 offscreen 每 5s 轮询一次 isAlive()：到达即重置空闲计时，保活即如此。
import { createSWService } from '@duoling/shared'

/** 心跳间隔：SW 空闲回收线是 30s，5s 一跳余量充足 */
export const SW_KEEPALIVE_INTERVAL_MS = 5000

const swService = createSWService()
let timer: ReturnType<typeof setInterval> | null = null

async function ping(): Promise<void> {
  try {
    await swService.isAlive()
  } catch {
    // SW 暂未就绪 / 无响应：跳过本周期，下个周期再试
  }
}

/** 宿主入口顶层调用（幂等）：启动保活轮询；无 chrome 环境为 no-op */
export function startSwKeepalive(intervalMs = SW_KEEPALIVE_INTERVAL_MS): void {
  if (timer || typeof chrome === 'undefined') return
  void ping()
  // node 环境的定时器句柄带 unref（不阻止进程退出）；浏览器端是 number，无此方法
  const handle = setInterval(() => void ping(), intervalMs) as unknown as { unref?: () => void }
  handle.unref?.()
  timer = handle as unknown as ReturnType<typeof setInterval>
}

/** 测试与显式复位用：停掉轮询（生产路径不调 —— 与 offscreen 容器同生命周期） */
export function stopSwKeepalive(): void {
  if (timer === null) return
  clearInterval(timer as unknown as Parameters<typeof clearInterval>[0])
  timer = null
}
