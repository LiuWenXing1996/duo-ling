import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getScripts = vi.fn()

beforeEach(() => {
  getScripts.mockReset()
  vi.useFakeTimers()
  vi.stubGlobal('chrome', {
    userScripts: { getScripts },
    runtime: { onUserScriptMessage: { addListener: vi.fn() } },
    tabs: { onRemoved: { addListener: vi.fn() } },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function makeRuntime(): Promise<import('@duoling/dl-core').DLRuntime> {
  vi.resetModules()
  const { DLRuntime } = await import('@duoling/dl-core')
  return new DLRuntime()
}

describe('DLRuntime 的引擎可用性', () => {
  it('isUserScriptsAvailable：getScripts 应答即真，抛错即假（开关关着时命名空间不存在）', async () => {
    getScripts.mockResolvedValueOnce([])
    const runtime = await makeRuntime()
    await expect(runtime.isUserScriptsAvailable()).resolves.toBe(true)

    getScripts.mockRejectedValueOnce(new Error('no userScripts'))
    await expect(runtime.isUserScriptsAvailable()).resolves.toBe(false)
  })

  it('首个读数只建基线，不回调', async () => {
    getScripts.mockResolvedValue([])
    const runtime = await makeRuntime()
    const seen: boolean[] = []
    runtime.onUserScriptsAvailableChange((v) => seen.push(v))
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual([])
    expect(getScripts).toHaveBeenCalledTimes(1)
  })

  it('只在翻转时回调（两个方向都算），平稳期不重复', async () => {
    getScripts.mockResolvedValue([])
    const runtime = await makeRuntime()
    const seen: boolean[] = []
    runtime.onUserScriptsAvailableChange((v) => seen.push(v))
    await vi.advanceTimersByTimeAsync(1000)

    getScripts.mockRejectedValue(new Error('off'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual([false])

    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual([false])

    getScripts.mockResolvedValue([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual([false, true])
  })

  it('多个订阅者共享一条轮询，都收到同一次翻转', async () => {
    getScripts.mockResolvedValue([])
    const runtime = await makeRuntime()
    const a: boolean[] = []
    const b: boolean[] = []
    runtime.onUserScriptsAvailableChange((v) => a.push(v))
    runtime.onUserScriptsAvailableChange((v) => b.push(v))
    await vi.advanceTimersByTimeAsync(1000)
    expect(getScripts).toHaveBeenCalledTimes(1)

    getScripts.mockRejectedValue(new Error('off'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(a).toEqual([false])
    expect(b).toEqual([false])
  })

  it('退到没有订阅者就停表：不再探测', async () => {
    getScripts.mockResolvedValue([])
    const runtime = await makeRuntime()
    const stop = runtime.onUserScriptsAvailableChange(() => {})
    await vi.advanceTimersByTimeAsync(1000)
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(getScripts).toHaveBeenCalledTimes(1)
  })
})
