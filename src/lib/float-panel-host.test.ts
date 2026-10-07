// logic 单测：float-panel-host —— 「这个标签页能不能挂浮层 / 跑内容脚本」的两条判据。
//
// webHostname 的要点在**扩展页**：`chrome-extension://<id>/workbench.html` 的 hostname 就是扩展
// 自己的 id —— 谁直接拿 hostname 当站点，就会把这串 id 当成一个「网站」显示。这条必须钉住。
//
// probeContentScript 的要点在**看应答、不看通道**：接收方改成异步应答（或收到一条不认识的
// 消息而沉默），「sendMessage 没抛错」就不再等于「注入得了」——判据得落在 pong 上。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeContentScript, webHostname } from './float-panel-host'

describe('webHostname（只认 http / https）', () => {
  it('普通网页：给 hostname（含端口不带端口的都取 host）', () => {
    expect(webHostname('https://example.com/page?a=1')).toBe('example.com')
    expect(webHostname('http://sub.example.com:8080/x')).toBe('sub.example.com')
  })

  it('扩展页：返回空串，绝不把扩展 id 当站点', () => {
    expect(webHostname('chrome-extension://abcdefghijklmnopabcdefghijklmnop/workbench.html')).toBe('')
  })

  it('浏览器内部页 / 本地文件：一律空串', () => {
    expect(webHostname('chrome://extensions/')).toBe('')
    expect(webHostname('chrome-untrusted://new-tab-page/')).toBe('')
    expect(webHostname('file:///tmp/page.html')).toBe('')
    expect(webHostname('about:blank')).toBe('')
    expect(webHostname('data:text/html,hi')).toBe('')
  })

  it('应用商店：scheme 上就是普通网页，照常给 hostname（拦它的是 Chrome 注入策略，判不出来）', () => {
    expect(webHostname('https://chromewebstore.google.com/detail/x')).toBe(
      'chromewebstore.google.com',
    )
  })

  it('拿不到 url / 空串 / 非法串：空串（非普通网页的常态）', () => {
    expect(webHostname(undefined)).toBe('')
    expect(webHostname('')).toBe('')
    expect(webHostname('not a url')).toBe('')
  })
})

describe('probeContentScript（问一句内容脚本在不在）', () => {
  /** 装一个只带 tabs.sendMessage 的 chrome 壳，返回可断言的 spy */
  function stubSendMessage(impl: () => unknown): ReturnType<typeof vi.fn> {
    const send = vi.fn(impl)
    vi.stubGlobal('chrome', { tabs: { sendMessage: send } })
    return send
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('内容脚本应答 pong → 注入得了（顺带钉住探活消息的 kind）', async () => {
    const send = stubSendMessage(async () => ({ ok: true }))
    expect(await probeContentScript(7)).toBe(true)
    expect(send).toHaveBeenCalledWith(7, { kind: 'content:ping' })
  })

  it('无人接收（Chrome 拦注入 / 站点没授权 / 内容脚本还没跑起来）→ 抛错归「不在」', async () => {
    stubSendMessage(async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.')
    })
    expect(await probeContentScript(7)).toBe(false)
  })

  it('通道通、却没人应答 pong → 不在（判据看应答，不看通道死活）', async () => {
    stubSendMessage(async () => undefined)
    expect(await probeContentScript(7)).toBe(false)
  })
})
