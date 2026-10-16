// host.ts 单测：SW 侧工厂的接线行为。
//
// createServiceWorkerHost：同步注册断言 —— 调用返回时监听必须已全部挂上（第一帧纪律），
// chrome 整体 stub，捕获 addListener 的注册函数来数监听面。**本包不自挂 onMessage**：
// 管理面命令面由 swIpcHandlers() 导出、宿主总线收口注册（见 management.ts），
// 故这里 onMessage 面断言为 0 —— 多一条就说明包又自己造了通信（违背标准化信道）。
//
// 模块生命周期：host.ts / host-config.ts / dl-bridge / dl-port 全带单例或 initialized
// 标志，跨用例必须全新 —— 每例经 loadHost()（resetModules + 动态 import）重载模块图。
// 不能静态 import + beforeEach 里 resetModules：静态绑定永远指向首个模块实例，
// 单例在旧实例里跨用例残留，resetModules 反而让动态重取的 host-config 分裂成新实例。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (raw: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown

let messageListeners: Listener[]
let swMessageListeners: Listener[]
let portConnectListeners: Array<(port: unknown) => void>
let contextMenuListeners: Array<(...args: unknown[]) => void>
let notificationListeners: Array<(id: string) => void>

beforeEach(() => {
  messageListeners = []
  swMessageListeners = []
  portConnectListeners = []
  contextMenuListeners = []
  notificationListeners = []
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-ext-id',
      onUserScriptMessage: { addListener: (fn: Listener) => messageListeners.push(fn) },
      onUserScriptConnect: { addListener: (fn: (p: unknown) => void) => portConnectListeners.push(fn) },
      onMessage: { addListener: (fn: Listener) => swMessageListeners.push(fn) },
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

/** handler pack 的加载口（管理面）：与 host 同一重载纪律 */
function loadManagement(): Promise<typeof import('./management')> {
  vi.resetModules()
  return import('./management')
}

describe('createServiceWorkerHost', () => {
  it('同步段注册全部监听：调用返回时消息 / 连接 / 事件源监听已挂上（第一帧纪律）', async () => {
    const { createServiceWorkerHost } = await loadHost()
    expect(messageListeners).toHaveLength(0)
    createServiceWorkerHost()
    // 消息面（onUserScriptMessage）与连接面（onUserScriptConnect）各一条
    expect(messageListeners).toHaveLength(1)
    expect(portConnectListeners).toHaveLength(1)
    // onMessage 面 **0 条**：管理面归 swIpcHandlers()（宿主总线注册），包不自挂
    expect(swMessageListeners).toHaveLength(0)
    // 事件源两件：菜单点击 / 通知点击（tabs.onUpdated 走 vi.fn，不入本数组）
    expect(contextMenuListeners).toHaveLength(1)
    expect(notificationListeners).toHaveLength(1)
  })

  it('管理面只读四条归 handler pack：认领这四条，其余 kind 不认领（让给宿主前缀路由）', async () => {
    const { swIpcHandlers, SW_IPC_OWNED_KINDS } = await loadManagement()
    const pack = swIpcHandlers()
    expect(SW_IPC_OWNED_KINDS).toEqual([
      'userscript:list',
      'userscript:getProject',
      'userscript:groups',
      'userscript:availability',
    ])
    for (const kind of SW_IPC_OWNED_KINDS) expect(pack.owns(kind)).toBe(true)
    // 保活已移出本包（@duoling/service-worker 认领）：这里必须让路
    expect(pack.owns('background:keepalive')).toBe(false)
    expect(pack.owns('other:kind')).toBe(false)
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

  it('addScript：传源码串自动建项目并注册（先自愈世界配置再走注册链）', async () => {
    const registered: Array<{ id: string; js: unknown[]; matches?: string[] }> = []
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-ext-id',
        onUserScriptMessage: { addListener: vi.fn() },
        onUserScriptConnect: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() },
      },
      tabs: { onRemoved: { addListener: vi.fn() }, onUpdated: { addListener: vi.fn() } },
      contextMenus: { onClicked: { addListener: vi.fn() } },
      notifications: { onClicked: { addListener: vi.fn() } },
      webRequest: { onHeadersReceived: { addListener: vi.fn() } },
      downloads: { onChanged: { addListener: vi.fn() } },
      declarativeNetRequest: {
        getSessionRules: vi.fn(async () => []),
        updateSessionRules: vi.fn(async () => {}),
      },
      userScripts: {
        getScripts: vi.fn(async () => []),
        configureWorld: vi.fn(async () => {}),
        register: vi.fn(async (scripts: typeof registered) => void registered.push(...scripts)),
        unregister: vi.fn(async () => {}),
      },
    })
    const { createServiceWorkerHost } = await loadHost()
    const host = createServiceWorkerHost()
    await host.addScript('// ==UserScript==\n// @match https://a.com/*\n// ==/UserScript==\nconsole.log(1)')
    expect(registered).toHaveLength(1)
    expect(registered[0]!.matches).toEqual(['https://a.com/*'])
    // 注入体是一条 code（GM 包装 + 源码拼一条，见 registration.registerScript）
    expect(registered[0]!.js).toEqual([expect.objectContaining({ code: expect.stringContaining('console.log(1)') })])
  })
})
