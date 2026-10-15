// host.ts 单测：两个工厂的接线行为。
//
// createServiceWorkerHost：同步注册断言 —— 调用返回时监听必须已全部挂上（第一帧纪律），
// chrome 整体 stub，捕获 addListener 的注册函数来数监听面。
// createOffscreenHost：走注册出的真实监听器端到端，验应答信封（{ ok, data | error }）。
//
// 模块生命周期：host.ts / host-config.ts / dl-bridge / dl-port 全带单例或 initialized
// 标志，跨用例必须全新 —— 每例经 loadHost()（resetModules + 动态 import）重载模块图。
// 不能静态 import + beforeEach 里 resetModules：静态绑定永远指向首个模块实例，
// 单例在旧实例里跨用例残留，resetModules 反而让动态重取的 host-config 分裂成新实例。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (raw: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown

let messageListeners: Listener[]
let portConnectListeners: Array<(port: unknown) => void>
let contextMenuListeners: Array<(...args: unknown[]) => void>
let notificationListeners: Array<(id: string) => void>

beforeEach(() => {
  messageListeners = []
  portConnectListeners = []
  contextMenuListeners = []
  notificationListeners = []
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-ext-id',
      onUserScriptMessage: { addListener: (fn: Listener) => messageListeners.push(fn) },
      onUserScriptConnect: { addListener: (fn: (p: unknown) => void) => portConnectListeners.push(fn) },
      onMessage: { addListener: vi.fn() },
    },
    tabs: { onRemoved: { addListener: vi.fn() }, onUpdated: { addListener: vi.fn() } },
    contextMenus: { onClicked: { addListener: (fn: never) => contextMenuListeners.push(fn) } },
    notifications: { onClicked: { addListener: (fn: (id: string) => void) => notificationListeners.push(fn) } },
    webRequest: { onHeadersReceived: { addListener: vi.fn() } },
    downloads: { onChanged: { addListener: vi.fn() } },
    declarativeNetRequest: {
      getSessionRules: vi.fn(async () => []),
      updateSessionRules: vi.fn(async () => {}),
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 每例重载模块图：单例 / 配置 / initialized 标志随注册表一起归零 */
function loadHost(): Promise<typeof import('./host')> {
  vi.resetModules()
  return import('./host')
}

describe('createServiceWorkerHost', () => {
  it('同步段注册全部监听：调用返回时消息 / 连接 / 事件源监听已挂上（第一帧纪律）', async () => {
    const { createServiceWorkerHost } = await loadHost()
    expect(messageListeners).toHaveLength(0)
    createServiceWorkerHost()
    // 消息面（onUserScriptMessage）与连接面（onUserScriptConnect）各一条
    expect(messageListeners).toHaveLength(1)
    expect(portConnectListeners).toHaveLength(1)
    // 事件源三件：菜单点击 / 通知点击 / 音频状态（tabs.onUpdated）
    expect(contextMenuListeners).toHaveLength(1)
    expect(notificationListeners).toHaveLength(1)
  })

  it('重复调用幂等：返回同一实例，监听不二次注册（initDlPort 无幂等保护，靠工厂兜住）', async () => {
    const { createServiceWorkerHost } = await loadHost()
    const first = createServiceWorkerHost()
    const second = createServiceWorkerHost()
    expect(second).toBe(first)
    expect(messageListeners).toHaveLength(1)
    expect(portConnectListeners).toHaveLength(1)
  })

  it('注入宿主配置后生效：extensionName 透传进 GM_notification 兜底标题的取值口', async () => {
    const { createServiceWorkerHost } = await loadHost()
    const host = createServiceWorkerHost({ extensionName: '测试扩展' })
    expect(host).toBeDefined()
    // 同一模块图内的读取口（loadHost 已 reset，host 与 host-config 同注册表）
    const { extensionName } = await import('./host-config')
    expect(extensionName()).toBe('测试扩展')
  })
})

describe('createOffscreenHost', () => {
  type MsgListener = (raw: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean
  let msgListener: MsgListener

  /** 装上 onMessage stub + DOM stub（node 环境手工 fake 到 execCommand 为止） */
  async function setupOffscreen(execCommandResult = true) {
    const { createOffscreenHost } = await loadHost()
    const onMessageAdd = vi.fn((fn: MsgListener) => {
      msgListener = fn
    })
    vi.stubGlobal('chrome', {
      runtime: { id: 'test-ext-id', onMessage: { addListener: onMessageAdd } },
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

  it('只认领自家命令面：非 clipboard:write 一律 return false，让给宿主自己的监听器', async () => {
    await setupOffscreen()
    expect(msgListener({ kind: 'fs:read' }, {}, vi.fn())).toBe(false)
    expect(msgListener(undefined, {}, vi.fn())).toBe(false)
  })

  it('clipboard:write（纯文本）应答 { ok: true }，copy 事件拿到 text/plain', async () => {
    const { copyHandlers } = await setupOffscreen()
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
    const { copyHandlers } = await setupOffscreen()
    await respond({ kind: 'clipboard:write', text: 'plain', html: '<b>rich</b>' })
    const setData = vi.fn()
    copyHandlers[0]!({ clipboardData: { setData }, preventDefault: vi.fn() })
    expect(setData).toHaveBeenCalledWith('text/html', '<b>rich</b>')
    expect(setData).toHaveBeenCalledWith('text/plain', 'plain')
  })

  it('execCommand 返回 false 报 INTERNAL 形状失败（{ ok: false, error }），不静默成功', async () => {
    await setupOffscreen(false)
    const resp = (await respond({ kind: 'clipboard:write', text: 'x' })) as { ok: boolean; error?: string }
    expect(resp.ok).toBe(false)
    expect(resp.error).toBeTruthy()
  })

  it('text 与 html 全空报参数错（信封 { ok: false }）', async () => {
    await setupOffscreen()
    const resp = (await respond({ kind: 'clipboard:write' })) as { ok: boolean; error?: string }
    expect(resp.ok).toBe(false)
    expect(resp.error).toContain('text')
  })

  it('handle 直调抛原始异常（不包信封）：未知命令抛错', async () => {
    const { host } = await setupOffscreen()
    await expect(host.handle({ kind: 'other' })).rejects.toThrow('未知 offscreen 命令')
  })
})

describe('GM_OFFSCREEN_REASONS', () => {
  it('reason 集与 GM 运行时的 offscreen 能力对齐（剪贴板必需，blob/worker 预留）', async () => {
    const { GM_OFFSCREEN_REASONS } = await loadHost()
    expect(GM_OFFSCREEN_REASONS).toContain('CLIPBOARD')
    expect(GM_OFFSCREEN_REASONS).toContain('BLOBS')
    expect(GM_OFFSCREEN_REASONS).toContain('WORKERS')
  })

  it('工厂链路在默认配置下成立（默认名兜底由 host-config 单测覆盖）', async () => {
    const { createServiceWorkerHost } = await loadHost()
    createServiceWorkerHost()
    expect(messageListeners).toHaveLength(1)
  })
})
