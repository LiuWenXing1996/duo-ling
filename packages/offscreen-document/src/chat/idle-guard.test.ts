import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdleGuard } from './idle-guard'

describe('createIdleGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('超过 idleMs 未 arm 时触发 onTimeout', () => {
    const onTimeout = vi.fn()
    const guard = createIdleGuard({ idleMs: 1000, onTimeout })
    guard.arm()
    vi.advanceTimersByTime(999)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('arm 会重置计时', () => {
    const onTimeout = vi.fn()
    const guard = createIdleGuard({ idleMs: 1000, onTimeout })
    guard.arm()
    vi.advanceTimersByTime(800)
    guard.arm()
    vi.advanceTimersByTime(800)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('dispose 取消待触发的计时', () => {
    const onTimeout = vi.fn()
    const guard = createIdleGuard({ idleMs: 1000, onTimeout })
    guard.arm()
    guard.dispose()
    vi.advanceTimersByTime(2000)
    expect(onTimeout).not.toHaveBeenCalled()
  })
})
