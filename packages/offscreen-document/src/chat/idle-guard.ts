/**
 * 流式静默守卫（纯逻辑，便于单测）：arm() 重置计时，超 idleMs 判定 provider 卡死并执行 onTimeout。
 * 为什么需要见 docs/adr/0025-stream-idle-guard.md。
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
