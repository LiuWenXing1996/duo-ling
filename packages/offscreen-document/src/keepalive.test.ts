// keepalive.ts 单测：轮询调度与报文形状。
//
// chrome 整体 stub：库的 sendMessage 走**回调形态**（chrome.runtime.sendMessage(msg, cb)），
// 故桩必须回调才算完成一跳。fake timers 驱动周期（本模块不碰 IndexedDB，fake timers 安全）。
// 模块带单例 timer，跨用例经 loadKeepalive()（resetModules + 动态 import）重载归零。
//
// 库在碰 chrome 之前先 await 一次，且代理调用再套一层 async，故「发出去」总落后调用栈
// 若干微任务 —— 断言前需 flush。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SW_SERVICE_KEY } from '@duoling/proxy-service-list'

/** 库把 key 拼成报文 type 后交给 chrome.runtime.sendMessage */
const MESSAGE_KEY = `proxy-service.${SW_SERVICE_KEY}`

type SendCallback = (response: unknown) => void
type StubRuntime = { sendMessage: ReturnType<typeof vi.fn>; lastError?: { message?: string } }

let runtime: StubRuntime

/** 让库的 await 链跑到底（假定时器下微任务照常推进） */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

beforeEach(() => {
  runtime = { sendMessage: vi.fn((_msg: unknown, cb: SendCallback) => cb({ res: true })) }
  vi.stubGlobal('chrome', { runtime })
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
  it('启动即 ping 一条，随后按周期续跳；报文经库发出（认 type、无 kind）', async () => {
    const { startSwKeepalive, SW_KEEPALIVE_INTERVAL_MS } = await loadKeepalive()
    startSwKeepalive()
    await flush()

    // key 值即断线点：两端共用同一字符串，改动等于同时改注册侧
    expect(SW_SERVICE_KEY).toBe('sw-service')
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1)
    const [msg] = runtime.sendMessage.mock.calls[0] as [
      { type?: string; data?: { path?: string[] }; kind?: unknown; timestamp?: number },
    ]
    expect(msg.type).toBe(MESSAGE_KEY)
    expect(msg.data?.path).toEqual(['isAlive'])
    // 形状互斥：总线的 kind 契约不得混进这条报文（混了会被总线的 matcher 认走）
    expect(msg.kind).toBeUndefined()
    expect(typeof msg.timestamp).toBe('number')

    await vi.advanceTimersByTimeAsync(SW_KEEPALIVE_INTERVAL_MS * 2)
    expect(runtime.sendMessage).toHaveBeenCalledTimes(3)
  })

  it('重复调用幂等：只保留第一个定时器，不翻倍', async () => {
    const { startSwKeepalive, SW_KEEPALIVE_INTERVAL_MS } = await loadKeepalive()
    startSwKeepalive()
    startSwKeepalive()
    await flush()
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(SW_KEEPALIVE_INTERVAL_MS * 2)
    expect(runtime.sendMessage).toHaveBeenCalledTimes(3)
  })

  it('ping 失败不外抛（SW 暂未就绪跳过本周期，下个周期再试）', async () => {
    runtime.sendMessage.mockImplementation((_msg: unknown, cb: SendCallback) => {
      runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' }
      cb(undefined)
    })
    const { startSwKeepalive, SW_KEEPALIVE_INTERVAL_MS } = await loadKeepalive()
    startSwKeepalive()
    await flush()
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(SW_KEEPALIVE_INTERVAL_MS)
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2)
  })

  it('无 chrome 环境（Node 单测）为 no-op：不挂定时器也不报错', async () => {
    vi.unstubAllGlobals()
    const { startSwKeepalive, SW_KEEPALIVE_INTERVAL_MS } = await loadKeepalive()
    expect(() => startSwKeepalive()).not.toThrow()
    await vi.advanceTimersByTimeAsync(SW_KEEPALIVE_INTERVAL_MS)
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('stopSwKeepalive 停跳后不再续', async () => {
    const { startSwKeepalive, stopSwKeepalive, SW_KEEPALIVE_INTERVAL_MS } = await loadKeepalive()
    startSwKeepalive()
    stopSwKeepalive()
    await flush()

    await vi.advanceTimersByTimeAsync(SW_KEEPALIVE_INTERVAL_MS * 2)
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1)
  })
})
