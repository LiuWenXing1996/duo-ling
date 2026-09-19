// dl-bridge.ts 单测：走真实监听器链路（initDlBridge 注册 → 捕获监听函数 → 手工投递消息）。
// chrome 由 vi.stubGlobal 整体替换（fakeBrowser 无 onUserScriptMessage），fetch 用 vi.fn 接管。
// cookie 段的域名门走真实状态库（fake-indexeddb 播种脚本配置），不 mock project-store。
import 'fake-indexeddb/auto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiRequest, ApiResponse } from './api-contract'
import { removeProjects, writeProject } from './state-db'
import type { ScriptProject } from './types'

type Listener = (raw: unknown, sender: unknown, sendResponse: (r: ApiResponse) => void) => unknown

let listeners: Listener[]
let sendToBridge: (req: ApiRequest, uuid?: string) => Promise<ApiResponse>
let fetchMock: ReturnType<typeof vi.fn>
let tabsMocks: { create: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
let windowUpdate: ReturnType<typeof vi.fn>
let cookiesMocks: {
  get: ReturnType<typeof vi.fn>
  getAll: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

/** 完整 chrome.cookies.Cookie 样本（测试只关心字段透传，故给全字段） */
function chromeCookie(over: Partial<chrome.cookies.Cookie> = {}): chrome.cookies.Cookie {
  return {
    name: 'sid',
    value: 'v1',
    domain: 'example.com',
    path: '/',
    secure: true,
    httpOnly: true,
    session: true,
    hostOnly: true,
    storeId: '0',
    sameSite: 'unspecified',
    ...over,
  }
}

/** 播种一个脚本项目（cookie 域名门的配置来源） */
function seedScript(uuid: string, matches: string[], excludeMatches?: string[]): Promise<void> {
  const project: ScriptProject = {
    v: 1,
    uuid,
    name: `cookie 脚本 ${uuid}`,
    enabled: true,
    config: { matches, excludeMatches, allFrames: true, runAt: 'document_end' },
    entry: 'main.js',
    createdAt: 1,
    updatedAt: 1,
  }
  return writeProject(project)
}

const COOKIE_UUID = 'cookie-u1'

beforeEach(async () => {
  vi.resetModules() // initDlBridge 有模块级 initialized 幂等标志，重置后每次都能重新注册
  listeners = []
  fetchMock = vi.fn()
  tabsMocks = { create: vi.fn(), remove: vi.fn(), update: vi.fn() }
  windowUpdate = vi.fn()
  cookiesMocks = {
    get: vi.fn(async () => chromeCookie()),
    getAll: vi.fn(async () => [chromeCookie()]),
    set: vi.fn(async (d: chrome.cookies.SetDetails) => chromeCookie({ name: d.name, value: d.value })),
    remove: vi.fn(async () => ({ name: 'sid', url: 'https://example.com/' })),
  }
  await removeProjects([COOKIE_UUID])
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('chrome', {
    runtime: { onUserScriptMessage: { addListener: (fn: Listener) => listeners.push(fn) } },
    tabs: tabsMocks,
    windows: { update: windowUpdate },
    cookies: cookiesMocks,
    // 错误路径会调 appendUserScriptError → chrome.storage，给个最小兜底防未处理拒绝噪音
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  })
  const mod = await import('./dl-bridge')
  mod.initDlBridge()
  sendToBridge = (req, uuid = 'u1') =>
    new Promise((resolve) => {
      listeners[0]!({ __dl: true, uuid, req }, { tab: { id: 1 } }, resolve)
    })
})

afterEach(async () => {
  // 顺序要紧：fake-indexeddb 内部靠定时器调度请求队列，fake timers 未还原时
  // 任何 IDB 调用都会永久挂起（表现为 hook 10s 超时，不是报错）
  vi.useRealTimers()
  await removeProjects([COOKIE_UUID])
  vi.unstubAllGlobals()
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

describe('DL.cookie（cookies 权限 + 域名门）', () => {
  it('越域被门拦下：报 PERMISSION_DENIED，且**完全不碰 chrome.cookies**', async () => {
    await seedScript(COOKIE_UUID, ['*://*.example.com/*'])
    const resp = await sendToBridge({ c: 'cookie.get', url: 'https://evil.test/' }, COOKIE_UUID)
    expect(resp.ok).toBe(false)
    if (!resp.ok) expect(resp.code).toBe('PERMISSION_DENIED')
    expect(cookiesMocks.get).not.toHaveBeenCalled()
    expect(cookiesMocks.getAll).not.toHaveBeenCalled()
  })

  it('命中脚本自身匹配域：恒返回数组，字段原样透传（httpOnly 照给）', async () => {
    await seedScript(COOKIE_UUID, ['https://example.com/foo/*']) // path 收窄不影响 cookie 作用域
    const resp = await sendToBridge({ c: 'cookie.get', url: 'https://example.com/' }, COOKIE_UUID)
    expect(resp.ok).toBe(true)
    if (resp.ok) {
      expect(resp.data).toEqual([
        {
          name: 'sid',
          value: 'v1',
          domain: 'example.com',
          path: '/',
          secure: true,
          httpOnly: true,
          session: true,
          hostOnly: true,
        },
      ])
    }
    expect(cookiesMocks.getAll).toHaveBeenCalledWith({ url: 'https://example.com/' })
  })

  it('指定 name：查单条，命中返回单元素数组、未命中返回空数组（不是 null）', async () => {
    await seedScript(COOKIE_UUID, ['<all_urls>'])
    const hit = await sendToBridge({ c: 'cookie.get', url: 'https://a.test/', name: 'sid' }, COOKIE_UUID)
    expect(hit.ok).toBe(true)
    if (hit.ok) expect((hit.data as unknown[]).length).toBe(1)

    cookiesMocks.get.mockResolvedValueOnce(null)
    const miss = await sendToBridge({ c: 'cookie.get', url: 'https://a.test/', name: 'nope' }, COOKIE_UUID)
    expect(miss).toEqual({ ok: true, data: [] })
  })

  it('非持久 cookie 不带 expirationDate 字段（不写 undefined 占位）', async () => {
    await seedScript(COOKIE_UUID, ['<all_urls>'])
    const resp = await sendToBridge({ c: 'cookie.get', url: 'https://a.test/' }, COOKIE_UUID)
    if (resp.ok) {
      const [c] = resp.data as Array<Record<string, unknown>>
      expect(c).not.toHaveProperty('expirationDate')
    }
  })

  it('cookie.set 只传 url（不传 domain / path，防架空域名门），可选字段按需透传', async () => {
    await seedScript(COOKIE_UUID, ['https://example.com/*'])
    const resp = await sendToBridge(
      {
        c: 'cookie.set',
        url: 'https://example.com/',
        name: 'k',
        value: 'v',
        secure: true,
        httpOnly: true,
        expirationDate: 1900000000,
      },
      COOKIE_UUID,
    )
    expect(resp).toEqual({ ok: true, data: undefined })
    expect(cookiesMocks.set).toHaveBeenCalledWith({
      url: 'https://example.com/',
      name: 'k',
      value: 'v',
      secure: true,
      httpOnly: true,
      expirationDate: 1900000000,
    })
  })

  it('cookie.set 缺 name / value 非字符串 → INVALID_ARG', async () => {
    await seedScript(COOKIE_UUID, ['<all_urls>'])
    const noName = await sendToBridge(
      { c: 'cookie.set', url: 'https://a.test/', name: '', value: 'v' },
      COOKIE_UUID,
    )
    expect(noName.ok).toBe(false)
    if (!noName.ok) expect(noName.code).toBe('INVALID_ARG')
    expect(cookiesMocks.set).not.toHaveBeenCalled()
  })

  it('cookie.remove 走门后调 chrome.cookies.remove', async () => {
    await seedScript(COOKIE_UUID, ['https://example.com/*'])
    const resp = await sendToBridge(
      { c: 'cookie.remove', url: 'https://example.com/', name: 'sid' },
      COOKIE_UUID,
    )
    expect(resp.ok).toBe(true)
    expect(cookiesMocks.remove).toHaveBeenCalledWith({ url: 'https://example.com/', name: 'sid' })
  })

  it('url 非 http(s) → INVALID_ARG（参数问题与越域区分开）', async () => {
    await seedScript(COOKIE_UUID, ['<all_urls>'])
    const resp = await sendToBridge({ c: 'cookie.get', url: 'about:blank' }, COOKIE_UUID)
    expect(resp.ok).toBe(false)
    if (!resp.ok) expect(resp.code).toBe('INVALID_ARG')
  })

  it('cookies API 不存在（权限未声明 / 旧产物）→ NOT_AVAILABLE，不静默返回空', async () => {
    await seedScript(COOKIE_UUID, ['<all_urls>'])
    const stubbed = globalThis.chrome as { cookies?: unknown }
    const saved = stubbed.cookies
    delete stubbed.cookies
    try {
      const resp = await sendToBridge({ c: 'cookie.get', url: 'https://a.test/' }, COOKIE_UUID)
      expect(resp.ok).toBe(false)
      if (!resp.ok) expect(resp.code).toBe('NOT_AVAILABLE')
    } finally {
      stubbed.cookies = saved
    }
  })
})

describe('DL.tab', () => {
  it('tab.save 落到 us:tab:<uuid>:<tabId> 键，tab.get 原样读回', async () => {
    const store: Record<string, unknown> = {}
    const setMock = chrome.storage.local.set as ReturnType<typeof vi.fn>
    const getMock = chrome.storage.local.get as ReturnType<typeof vi.fn>
    setMock.mockImplementation(async (o: Record<string, unknown>) => {
      Object.assign(store, o)
    })
    getMock.mockImplementation(async (k: string | null) =>
      k === null ? { ...store } : { [k]: store[k] },
    )
    const saveResp = await sendToBridge({ c: 'tab.save', value: { n: 1, s: 'x' } })
    expect(saveResp).toEqual({ ok: true, data: undefined })
    expect(setMock).toHaveBeenCalledWith({ 'us:tab:u1:1': { n: 1, s: 'x' } })
    const getResp = await sendToBridge({ c: 'tab.get' })
    expect(getResp).toEqual({ ok: true, data: { n: 1, s: 'x' } })
  })

  it('tab.all 只聚合本脚本的 tab 键，键为 tabId 字符串', async () => {
    const store: Record<string, unknown> = {
      'us:tab:u1:11': { a: 1 },
      'us:tab:u1:22': { a: 2 },
      'us:tab:other:11': { leak: true }, // 别的脚本，不应混入
    }
    ;(chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ ...store }))
    const resp = await sendToBridge({ c: 'tab.all' })
    expect(resp).toEqual({ ok: true, data: { '11': { a: 1 }, '22': { a: 2 } } })
  })

  it('无标签页上下文（sender.tab 缺失）报 INVALID_ARG', async () => {
    // sendToBridge 固定带 { tab: { id: 1 } }，这里用裸监听器投递一个无 tab 的 sender
    const resp = await new Promise((resolve) => {
      listeners[0]!({ __dl: true, uuid: 'u1', req: { c: 'tab.get' } }, {}, resolve)
    })
    expect(resp).toMatchObject({ ok: false, code: 'INVALID_ARG' })
  })
})

describe('parseTabKey', () => {
  it('解析 us:tab:<uuid>:<tabId>', async () => {
    const { parseTabKey } = await import('./dl-bridge')
    expect(parseTabKey('us:tab:u1:42')).toEqual({ uuid: 'u1', tabId: 42 })
    expect(parseTabKey('us:tab:abc-123:0')).toEqual({ uuid: 'abc-123', tabId: 0 })
  })
  it('非 tab 前缀 / 缺 tabId / tabId 非整数返回 null', async () => {
    const { parseTabKey } = await import('./dl-bridge')
    expect(parseTabKey('us:gm:u1:k')).toBeNull()
    expect(parseTabKey('us:tab:u1:')).toBeNull()
    expect(parseTabKey('us:tab:u1:xx')).toBeNull()
  })
})
