// host.ts 单测：offscreen 侧宿主的接线与剪贴板命令应答。
//
// createOffscreenHost：走注册出的真实监听器端到端，验应答信封（{ ok, data | error }）；
// handle 直调抛原始异常（不包信封）。GM_OFFSCREEN_REASONS 与 GM 运行时的 offscreen 能力对齐。
//
// chrome / document / window 全 stub（node 环境手工 fake 到 execCommand 为止）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOffscreenHost, GM_OFFSCREEN_REASONS } from './host'

type MsgListener = (raw: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean

let msgListener: MsgListener

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 装上 onMessage stub + DOM stub（node 环境手工 fake 到 execCommand 为止） */
function setupOffscreen(execCommandResult = true) {
  const onMessageAdd = vi.fn((fn: MsgListener) => {
    msgListener = fn
  })
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-ext-id',
      onMessage: { addListener: onMessageAdd },
      sendMessage: vi.fn(async () => undefined),
    },
  })
  const el = {
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    focus: vi.fn(),
    remove: vi.fn(),
    contentEditable: '',
    innerHTML: '',
    value: '',
  }
  const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() }
  const copyHandlers: Array<(e: unknown) => void> = []
  vi.stubGlobal('document', {
    createElement: vi.fn(() => el),
    body: { appendChild: vi.fn() },
    addEventListener: vi.fn((_t: string, fn: (e: unknown) => void) => copyHandlers.push(fn)),
    removeEventListener: vi.fn(),
    execCommand: vi.fn(() => execCommandResult),
    createRange: vi.fn(() => ({ selectNodeContents: vi.fn() })),
  })
  vi.stubGlobal('window', { getSelection: () => selection })
  const host = createOffscreenHost()
  return { host, el, copyHandlers }
}

function respond(raw: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    msgListener(raw, {}, resolve)
  })
}

describe('createOffscreenHost', () => {
  it('只认领自家命令面：非 clipboard:write 一律 return false，让给宿主自己的监听器', () => {
    setupOffscreen()
    expect(msgListener({ kind: 'fs:read' }, {}, vi.fn())).toBe(false)
    expect(msgListener(undefined, {}, vi.fn())).toBe(false)
  })

  it('clipboard:write（纯文本）应答 { ok: true }，copy 事件拿到 text/plain', async () => {
    const { copyHandlers } = setupOffscreen()
    const resp = (await respond({ kind: 'clipboard:write', text: '你好', html: null })) as {
      ok: boolean
    }
    expect(resp.ok).toBe(true)
    expect(copyHandlers).toHaveLength(1)
    const setData = vi.fn()
    copyHandlers[0]!({ clipboardData: { setData }, preventDefault: vi.fn() })
    expect(setData).toHaveBeenCalledWith('text/plain', '你好')
  })

  it('clipboard:write（富文本）双格式都进 clipboardData', async () => {
    const { copyHandlers } = setupOffscreen()
    await respond({ kind: 'clipboard:write', text: 'plain', html: '<b>rich</b>' })
    const setData = vi.fn()
    copyHandlers[0]!({ clipboardData: { setData }, preventDefault: vi.fn() })
    expect(setData).toHaveBeenCalledWith('text/html', '<b>rich</b>')
    expect(setData).toHaveBeenCalledWith('text/plain', 'plain')
  })

  it('execCommand 返回 false 报失败信封（{ ok: false, error }），不静默成功', async () => {
    setupOffscreen(false)
    const resp = (await respond({ kind: 'clipboard:write', text: 'x' })) as { ok: boolean; error?: string }
    expect(resp.ok).toBe(false)
    expect(resp.error).toBeTruthy()
  })

  it('text 与 html 全空报参数错（信封 { ok: false }）', async () => {
    setupOffscreen()
    const resp = (await respond({ kind: 'clipboard:write' })) as { ok: boolean; error?: string }
    expect(resp.ok).toBe(false)
    expect(resp.error).toContain('text')
  })

  it('handle 直调抛原始异常（不包信封）：未知命令抛错', async () => {
    const { host } = setupOffscreen()
    await expect(host.handle({ kind: 'other' })).rejects.toThrow('未知 offscreen 命令')
  })
})

describe('GM_OFFSCREEN_REASONS', () => {
  it('reason 集与 GM 运行时的 offscreen 能力对齐（剪贴板必需，blob/worker 预留）', () => {
    expect(GM_OFFSCREEN_REASONS).toContain('CLIPBOARD')
    expect(GM_OFFSCREEN_REASONS).toContain('BLOBS')
    expect(GM_OFFSCREEN_REASONS).toContain('WORKERS')
  })
})
