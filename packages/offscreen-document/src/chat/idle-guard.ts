/**
 * 流式静默守卫（纯逻辑，便于单测）：
 * 调用方在流发起前 arm() 一次（覆盖首字节），此后每收到一个 chunk 再 arm() 重置计时；
 * 超过 idleMs 未 arm() 即判定 provider 卡死（有连接但不吐 token），执行 onTimeout
 * （通常由其 abort 流并提示用户）。dispose() 在流结束时清掉定时器，避免泄漏。
 *
 * 用途：防止「生成脚本」请求在 provider 静默卡死时永久占用网关连接/并发配额，
 * 累积触发限流（用户手动停止走 abortChat，与此计时无关）。
 */
export function createIdleGuard(opts: {
  idleMs: number
  onTimeout: () => void
}): { arm: () => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => opts.onTimeout(), opts.idleMs)
  }
  return {
    arm,
    dispose: () => {
      if (timer) clearTimeout(timer)
    },
  }
}
