// keepalive.ts 单测：心跳协议与调度行为。
//
// chrome 整体 stub（sendMessage 可观测）；fake timers 驱动周期（本模块不碰 IndexedDB，
// fake timers 安全）。模块带单例 timer，跨用例经 loadKeepalive()（resetModules + 动态
// import）重载归零。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let sendMessage: ReturnType<typeof vi.fn>

beforeEach(() => {
  sendMessage = vi.fn(async () => ({ alive: true }))
  vi.stubGlobal('chrome', { runtime: { sendMessage } })
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** 每例重载模块：单例 timer 随注册表归零 */
function loadKeepalive(): Promise<typeof import('./keepalive')> {
  vi.resetModules()
  return import('./keepalive')
}

describe('startSwKeepalive', () => {
  it('启动即 ping 一条，随后按周期续跳；报文 kind 是真相源常量', async () => {
    const { startSwKeepalive, SW_KEEPALIVE_KIND, SW_KEEPALIVE_INTERVAL_MS } = await loadKeepalive()
    startSwKeepalive()
    expect(SW_KEEPALIVE_KIND).toBe('usrt:keepalive')
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith({ kind: SW_KEEPALIVE_KIND })
    await vi.advanceTimersByTimeAsync(SW_KEEPALIVE_INTERVAL_MS * 2)
    expect(sendMessage).toHaveBeenCalledTimes(3)
  })

  it('重复调用幂等：只保留第一个定时器，不翻倍', async () => {
    const { startSwKeepalive, SW_KEEPALIVE_INTERVAL_MS } = await loadKeepalive()
    startSwKeepalive()
    startSwKeepalive()
    await vi.advanceTimersByTimeAsync(SW_KEEPALIVE_INTERVAL_MS * 2)
    expect(sendMessage).toHaveBeenCalledTimes(3)
  })

  it('ping 失败不外抛（SW 暂未就绪跳过本周期，下个周期再试）', async () => {
    sendMessage.mockRejectedValue(new Error('Could not establish connection'))
    const { startSwKeepalive, SW_KEEPALIVE_INTERVAL_MS } = await loadKeepalive()
    startSwKeepalive()
    await vi.advanceTimersByTimeAsync(SW_KEEPALIVE_INTERVAL_MS)
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('无 chrome 环境（Node 单测）为 no-op：不挂定时器也不报错', async () => {
    vi.unstubAllGlobals()
    const { startSwKeepalive, SW_KEEPALIVE_INTERVAL_MS } = await loadKeepalive()
    expect(() => startSwKeepalive()).not.toThrow()
    await vi.advanceTimersByTimeAsync(SW_KEEPALIVE_INTERVAL_MS)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('stopSwKeepalive 停跳后不再续', async () => {
    const { startSwKeepalive, stopSwKeepalive, SW_KEEPALIVE_INTERVAL_MS } = await loadKeepalive()
    startSwKeepalive()
    stopSwKeepalive()
    await vi.advanceTimersByTimeAsync(SW_KEEPALIVE_INTERVAL_MS * 2)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})
