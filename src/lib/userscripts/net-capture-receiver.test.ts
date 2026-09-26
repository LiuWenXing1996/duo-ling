// net-capture-receiver 单测：只接 __dlNetCapture 录制信封，其余消息一律放行（返回 undefined，
// 不占响应权）—— 后者是关键不变量：VM 运行时的 GetInjected / 内核命令经同一 onUserScriptMessage
// 通道，若本监听抢答会挤掉真正应答方（Phase A 踩过的坑）。
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./net-record-protocol', () => ({
  normalizeCapture: vi.fn(() => ({ host: 'x.test', entries: [], tail: null, ts: 0 })),
}))
vi.mock('./netlog-db', () => ({
  appendCapture: vi.fn(async () => {}),
}))

import { normalizeCapture } from './net-record-protocol'
import { appendCapture } from './netlog-db'

type Listener = (raw: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown

let listeners: Listener[]

beforeEach(async () => {
  vi.resetModules()
  listeners = []
  vi.mocked(normalizeCapture).mockClear()
  vi.mocked(appendCapture).mockClear()
  vi.stubGlobal('chrome', {
    runtime: { onUserScriptMessage: { addListener: (fn: Listener) => listeners.push(fn) } },
  })
  const mod = await import('./net-capture-receiver')
  mod.initNetCaptureReceiver()
})

describe('网络录制接收', () => {
  it('__dlNetCapture 信封 → 白名单化后落库', async () => {
    listeners[0]!({ __dlNetCapture: true, host: 'x.test', capture: { a: 1 } }, {}, () => {})
    expect(normalizeCapture).toHaveBeenCalledWith('x.test', { a: 1 })
    expect(appendCapture).toHaveBeenCalledTimes(1)
  })

  it('归一化返回 null（非法载荷）→ 不落库', async () => {
    vi.mocked(normalizeCapture).mockReturnValueOnce(null)
    listeners[0]!({ __dlNetCapture: true, host: 'x.test', capture: {} }, {}, () => {})
    expect(appendCapture).not.toHaveBeenCalled()
  })

  it('非录制消息（如 VM 的 GetInjected / 内核命令）返回 undefined、不落库、不占响应权', () => {
    const ret = listeners[0]!({ __dl: true, uuid: 'u1', req: { c: 'fetch' } }, {}, () => {})
    expect(ret).toBeUndefined()
    expect(appendCapture).not.toHaveBeenCalled()
  })
})
