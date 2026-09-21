// dl-bridge.ts 单测：走真实监听器链路（initDlBridge 注册 → 捕获监听函数 → 手工投递消息）。
// chrome 由 vi.stubGlobal 整体替换（fakeBrowser 无 onUserScriptMessage），fetch 用 vi.fn 接管。
// cookie 段的域名门与 GM tab 后端走真实 IndexedDB（fake-indexeddb 播种/断言），不 mock 存储层。
import 'fake-indexeddb/auto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiRequest, ApiResponse } from './api-contract'
import { removeProjects, writeProject } from './state-db'
import { clearAllForTests, getTabValue as getTabRecord, putTabValue as putTabRecord } from './usdata-db'
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
let dnrMocks: { updateSessionRules: ReturnType<typeof vi.fn>; getSessionRules: ReturnType<typeof vi.fn> }
let webRequestListeners: Array<(details: unknown) => void>

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
    v: 2,
    uuid,
    name: `cookie 脚本 ${uuid}`,
    enabled: true,
    config: { matches, excludeMatches, allFrames: true, runAt: 'document_end' },
    group: '',
    source: { code: '// x', savedAt: 1 },
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
  await clearAllForTests()
  dnrMocks = { updateSessionRules: vi.fn(async () => {}), getSessionRules: vi.fn(async () => []) }
  webRequestListeners = []
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-ext-id',
      onUserScriptMessage: { addListener: (fn: Listener) => listeners.push(fn) },
    },
    tabs: tabsMocks,
    windows: { update: windowUpdate },
    cookies: cookiesMocks,
    declarativeNetRequest: dnrMocks,
    webRequest: { onHeadersReceived: { addListener: (fn: (d: unknown) => void) => webRequestListeners.push(fn) } },
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

describe('GM_xmlhttpRequest timeout', () => {
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

describe('GM_xmlhttpRequest 二进制请求体', () => {
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

describe('GM_xmlhttpRequest forbidden header 覆写（DNR session 规则）', () => {
  it('禁设头收进规则（set），原生头留在 Headers；settle 后撤规则', async () => {
    fetchMock.mockResolvedValue(new Response('ok'))
    const resp = await sendToBridge({
      c: 'fetch',
      url: 'https://x.test/api',
      init: { headers: { Cookie: 'a=1', Referer: 'https://r.test/', 'User-Agent': 'UA1', 'X-Custom': 'v' } },
    })
    expect(resp.ok).toBe(true)

    // 挂载：set 操作 + host 级作用域 + 自家 initiator
    expect(dnrMocks.updateSessionRules).toHaveBeenCalledTimes(2)
    const attach = dnrMocks.updateSessionRules.mock.calls[0]![0]
    expect(attach.addRules).toHaveLength(1)
    const rule = attach.addRules[0]
    expect(rule.action.type).toBe('modifyHeaders')
    expect(rule.action.requestHeaders).toEqual([
      { header: 'cookie', operation: 'set', value: 'a=1' },
      { header: 'referer', operation: 'set', value: 'https://r.test/' },
      { header: 'user-agent', operation: 'set', value: 'UA1' },
    ])
    expect(rule.condition).toEqual({ requestDomains: ['x.test'], initiatorDomains: ['test-ext-id'] })
    expect(attach.removeRuleIds).toEqual([rule.id])

    // 原生路径：禁设头不进 Headers（fetch 会静默丢弃的路），普通头保留
    const init = fetchMock.mock.calls[0]![1]
    expect(init.headers.get('cookie')).toBeNull()
    expect(init.headers.get('referer')).toBeNull()
    expect(init.headers.get('x-custom')).toBe('v')

    // 用后即撤
    const detach = dnrMocks.updateSessionRules.mock.calls[1]![0]
    expect(detach.removeRuleIds).toEqual([rule.id])
    expect(detach.addRules).toBeUndefined()
  })

  it('纯 fetch（无禁设头）不挂 DNR 规则', async () => {
    fetchMock.mockResolvedValue(new Response('ok'))
    await sendToBridge({ c: 'fetch', url: 'https://x.test/', init: { headers: { 'X-Ok': '1' } } })
    expect(dnrMocks.updateSessionRules).not.toHaveBeenCalled()
  })

  it('超时中止后同样撤规则（用后即撤对错误路径成立）', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject((init.signal as AbortSignal).reason))
      })
    })
    const p = sendToBridge({
      c: 'fetch',
      url: 'https://x.test/',
      init: { timeout: 300, headers: { Cookie: 'a=1' } },
    })
    await vi.advanceTimersByTimeAsync(300)
    const resp = await p
    expect(resp.ok).toBe(false)
    if (!resp.ok) expect(resp.code).toBe('BRIDGE_TIMEOUT')
    const calls = dnrMocks.updateSessionRules.mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[1]![0].removeRuleIds).toEqual([calls[0]![0].addRules[0].id])
  })

  it('redirect 非法值报 INVALID_ARG', async () => {
    const resp = await sendToBridge({
      c: 'fetch',
      url: 'https://x.test/',
      init: { redirect: 'nope' as unknown as 'manual' },
    })
    expect(resp.ok).toBe(false)
    if (!resp.ok) expect(resp.code).toBe('INVALID_ARG')
  })
})

describe("GM_xmlhttpRequest redirect:'manual'（webRequest 观测）", () => {
  it('opaqueredirect 配观测合成 3xx 响应：status/headers/location、body 空、url 为请求 URL', async () => {
    fetchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10)) // 留出观测窗口
      return { type: 'opaqueredirect', status: 0 } as unknown as Response
    })
    const p = sendToBridge({ c: 'fetch', url: 'https://x.test/r', init: { redirect: 'manual' } })
    // fetch 收到 manual 语义；等待者先于 fetch 登记
    await new Promise((r) => setTimeout(r, 5))
    expect(fetchMock.mock.calls[0]![1].redirect).toBe('manual')
    webRequestListeners[0]!({
      url: 'https://x.test/r',
      statusCode: 302,
      responseHeaders: [
        { name: 'Location', value: 'https://y.test/next' },
        { name: 'Set-Cookie', value: 'k=1' },
      ],
    })
    const resp = await p
    expect(resp.ok).toBe(true)
    if (resp.ok) {
      expect(resp.data).toMatchObject({
        ok: false,
        status: 302,
        statusText: '',
        url: 'https://x.test/r',
        body: '',
        responseType: 'text',
      })
      expect((resp.data as { headers: Record<string, string> }).headers).toEqual({
        location: 'https://y.test/next',
        'set-cookie': 'k=1',
      })
    }
  })

  it('观测缺失时兜底报 INTERNAL，不挂死', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue({ type: 'opaqueredirect', status: 0 } as unknown as Response)
    const p = sendToBridge({ c: 'fetch', url: 'https://x.test/r', init: { redirect: 'manual' } })
    await vi.advanceTimersByTimeAsync(5000)
    const resp = await p
    expect(resp.ok).toBe(false)
    if (!resp.ok) expect(resp.code).toBe('INTERNAL')
  })

  it("非 3xx 的 manual 请求（直接 200）走正常响应路径", async () => {
    fetchMock.mockResolvedValue(new Response('plain'))
    const resp = await sendToBridge({ c: 'fetch', url: 'https://x.test/', init: { redirect: 'manual' } })
    expect(resp.ok).toBe(true)
    if (resp.ok) expect(resp.data).toMatchObject({ status: 200, body: 'plain' })
  })
})

describe('GM tabs', () => {
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

describe('GM tab', () => {
  it('tab.save 落 duoling-usdata 库，tab.get 原样读回', async () => {
    const saveResp = await sendToBridge({ c: 'tab.save', value: { n: 1, s: 'x' } })
    expect(saveResp).toEqual({ ok: true, data: undefined })
    // 落库事实：复合主键 [uuid, tabId] 直读
    const rec = await getTabRecord('u1', 1)
    expect(rec).toEqual({ n: 1, s: 'x' })
    const getResp = await sendToBridge({ c: 'tab.get' })
    expect(getResp).toEqual({ ok: true, data: { n: 1, s: 'x' } })
  })

  it('tab.all 只聚合本脚本的 tab 记录，键为 tabId 字符串', async () => {
    await putTabRecord('u1', 11, { a: 1 })
    await putTabRecord('u1', 22, { a: 2 })
    await putTabRecord('other', 11, { leak: true }) // 别的脚本，不应混入
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
