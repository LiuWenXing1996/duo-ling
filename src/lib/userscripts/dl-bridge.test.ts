// dl-bridge.ts 单测：走真实监听器链路（initDlBridge 注册 → 捕获监听函数 → 手工投递消息）。
// chrome 由 vi.stubGlobal 整体替换（fakeBrowser 无 onUserScriptMessage），fetch 用 vi.fn 接管。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiRequest, ApiResponse } from './api-contract'

type Listener = (raw: unknown, sender: unknown, sendResponse: (r: ApiResponse) => void) => unknown

let listeners: Listener[]
let sendToBridge: (req: ApiRequest) => Promise<ApiResponse>
let fetchMock: ReturnType<typeof vi.fn>
let tabsMocks: { create: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
let windowUpdate: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.resetModules() // initDlBridge 有模块级 initialized 幂等标志，重置后每次都能重新注册
  listeners = []
  fetchMock = vi.fn()
  tabsMocks = { create: vi.fn(), remove: vi.fn(), update: vi.fn() }
  windowUpdate = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('chrome', {
    runtime: { onUserScriptMessage: { addListener: (fn: Listener) => listeners.push(fn) } },
    tabs: tabsMocks,
    windows: { update: windowUpdate },
    // 错误路径会调 appendUserScriptError → chrome.storage，给个最小兜底防未处理拒绝噪音
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  })
  const mod = await import('./dl-bridge')
  mod.initDlBridge()
  sendToBridge = (req) =>
    new Promise((resolve) => {
      listeners[0]!({ __dl: true, uuid: 'u1', req }, { tab: { id: 1 } }, resolve)
    })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('DL.fetch timeout', () => {
  it('到点中止请求，报 BRIDGE_TIMEOUT，fetch 收到 abort signal', async () => {
    vi.useFakeTimers()
    // 挂死不返回的请求：只在被 abort 时 reject
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject((init.signal as AbortSignal).reason))
      })
    })
    const p = sendToBridge({ c: 'fetch', url: 'https://x.test/', init: { timeout: 500 } })
    await vi.advanceTimersByTimeAsync(500)
    const resp = await p
    expect(resp.ok).toBe(false)
    if (!resp.ok) {
      expect(resp.code).toBe('BRIDGE_TIMEOUT')
      expect(resp.error).toContain('500ms')
    }
  })

  it('timeout 为 0 表示不限：请求正常完成，不触发中止', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(new Response('hi'))
    const resp = await sendToBridge({ c: 'fetch', url: 'https://x.test/', init: { timeout: 0 } })
    expect(resp.ok).toBe(true)
    if (resp.ok) expect(resp.data).toMatchObject({ body: 'hi', status: 200 })
  })

  it('不传 timeout：行为与原来一致', async () => {
    fetchMock.mockResolvedValue(new Response('ok'))
    const resp = await sendToBridge({ c: 'fetch', url: 'https://x.test/' })
    expect(resp.ok).toBe(true)
  })
})

describe('DL.fetch 二进制请求体', () => {
  it('信封解码为 Uint8Array 传给 fetch（字节逐个还原，0x00 / 0xff 不被 UTF-8 破坏）', async () => {
    fetchMock.mockResolvedValue(new Response('ok'))
    // [0x00, 0xff, 0x10, 0x41]——含 UTF-8 编码会破坏的字节
    const b64 = btoa(String.fromCharCode(0x00, 0xff, 0x10, 0x41))
    await sendToBridge({
      c: 'fetch',
      url: 'https://x.test/',
      init: { method: 'POST', body: { __dlBinaryBody: true, base64: b64 } },
    })
    const body = fetchMock.mock.calls[0]![1].body as Uint8Array
    expect(body).toBeInstanceOf(Uint8Array)
    expect(Array.from(body)).toEqual([0x00, 0xff, 0x10, 0x41])
  })

  it('字符串体原样透传，不受信封逻辑影响', async () => {
    fetchMock.mockResolvedValue(new Response('ok'))
    await sendToBridge({
      c: 'fetch',
      url: 'https://x.test/',
      init: { method: 'POST', body: 'hello=1' },
    })
    expect(fetchMock.mock.calls[0]![1].body).toBe('hello=1')
  })

  it('非法 body 对象（非信封形状）报 INVALID_ARG，不静默吞', async () => {
    const resp = await sendToBridge({
      c: 'fetch',
      url: 'https://x.test/',
      init: { method: 'POST', body: { base64: 'xxx' } as unknown as string },
    })
    expect(resp.ok).toBe(false)
    if (!resp.ok) expect(resp.code).toBe('INVALID_ARG')
  })
})

describe('DL.tabs', () => {
  it('tabs.open 返回新标签页的 tabId', async () => {
    tabsMocks.create.mockResolvedValue({ id: 7 })
    const resp = await sendToBridge({ c: 'tabs.open', url: 'https://a.test/' })
    expect(tabsMocks.create).toHaveBeenCalledWith({ url: 'https://a.test/', active: true })
    expect(resp).toEqual({ ok: true, data: 7 })
  })

  it('tabs.close 调 chrome.tabs.remove', async () => {
    tabsMocks.remove.mockResolvedValue(undefined)
    const resp = await sendToBridge({ c: 'tabs.close', tabId: 7 })
    expect(tabsMocks.remove).toHaveBeenCalledWith(7)
    expect(resp).toEqual({ ok: true, data: undefined })
  })

  it('tabs.focus 激活标签页并聚焦所在窗口', async () => {
    tabsMocks.update.mockResolvedValue({ id: 7, windowId: 3 })
    windowUpdate.mockResolvedValue(undefined)
    const resp = await sendToBridge({ c: 'tabs.focus', tabId: 7 })
    expect(tabsMocks.update).toHaveBeenCalledWith(7, { active: true })
    expect(windowUpdate).toHaveBeenCalledWith(3, { focused: true })
    expect(resp).toEqual({ ok: true, data: undefined })
  })

  it('tabs.focus 拿不到 windowId 时不调窗口聚焦，整体仍成功', async () => {
    tabsMocks.update.mockResolvedValue({ id: 7 })
    const resp = await sendToBridge({ c: 'tabs.focus', tabId: 7 })
    expect(windowUpdate).not.toHaveBeenCalled()
    expect(resp.ok).toBe(true)
  })
})
