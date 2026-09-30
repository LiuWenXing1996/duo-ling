// availability-watch.ts（检测层）单测：基线 / 变化广播 / 反向变化 / 幂等启动 / 探测失败保基线。
// getUserScriptsStatus（engine）整体 mock——本文件只验证「变化才发事件」的语义。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserScriptsAvailability } from './types'

const getUserScriptsStatus = vi.hoisted(() => vi.fn())
vi.mock('./engine', () => ({ getUserScriptsStatus }))

const OFF: UserScriptsAvailability = { available: false, isFirefox: false, chromeMajor: 140, guideText: '' }
const ON: UserScriptsAvailability = { available: true, isFirefox: false, chromeMajor: 140, guideText: '' }

async function fresh(): Promise<typeof import('./availability-watch')> {
  vi.resetModules()
  return import('./availability-watch')
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('availability-watch（检测层：变化才广播）', () => {
  it('首个读数只建基线，不广播', async () => {
    getUserScriptsStatus.mockResolvedValue(OFF)
    const w = await fresh()
    const seen: unknown[] = []
    w.onAvailabilityChange((c) => seen.push(c))
    w.startAvailabilityWatch(5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(seen).toHaveLength(0)
  })

  it('状态变化才广播，携带 previous / current / changedAt；平稳期不广播', async () => {
    getUserScriptsStatus.mockResolvedValue(OFF)
    const w = await fresh()
    const seen: unknown[] = []
    w.onAvailabilityChange((c) => seen.push(c))
    w.startAvailabilityWatch(5000)
    await vi.advanceTimersByTimeAsync(5000) // 基线 = OFF

    getUserScriptsStatus.mockResolvedValue(ON)
    await vi.advanceTimersByTimeAsync(5000) // 翻转 OFF → ON
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ previous: false, current: { available: true } })
    expect((seen[0] as { changedAt: number }).changedAt).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(5000) // 平稳期
    expect(seen).toHaveLength(1)
  })

  it('反向变化（开 → 关）同样广播（UI 横幅要重新出现）', async () => {
    getUserScriptsStatus.mockResolvedValue(ON)
    const w = await fresh()
    const seen: unknown[] = []
    w.onAvailabilityChange((c) => seen.push(c))
    w.startAvailabilityWatch(5000)
    await vi.advanceTimersByTimeAsync(5000) // 基线 = ON

    getUserScriptsStatus.mockResolvedValue(OFF)
    await vi.advanceTimersByTimeAsync(5000)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ previous: true, current: { available: false } })
  })

  it('startAvailabilityWatch 幂等：重复启动不叠加轮询', async () => {
    getUserScriptsStatus.mockResolvedValue(OFF)
    const w = await fresh()
    w.startAvailabilityWatch(5000)
    w.startAvailabilityWatch(5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(getUserScriptsStatus).toHaveBeenCalledTimes(1)
  })

  it('单次探测失败保留基线，恢复后正常比较', async () => {
    getUserScriptsStatus.mockResolvedValue(OFF)
    const w = await fresh()
    const seen: unknown[] = []
    w.onAvailabilityChange((c) => seen.push(c))
    w.startAvailabilityWatch(5000)
    await vi.advanceTimersByTimeAsync(5000) // 基线 = OFF

    getUserScriptsStatus.mockRejectedValueOnce(new Error('boom'))
    await vi.advanceTimersByTimeAsync(5000) // 失败：基线不动、不发事件
    expect(seen).toHaveLength(0)

    getUserScriptsStatus.mockResolvedValue(ON)
    await vi.advanceTimersByTimeAsync(5000) // 恢复后仍能识别翻转
    expect(seen).toHaveLength(1)
  })
})
