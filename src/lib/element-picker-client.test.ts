// 拾取发起侧封装的纯函数 / 判据测试。
// 超时兜底与 reqId 配对在 page-inspector-bridge 的单测里覆盖（同一条通道，本文件不重复那一层）；
// chrome API 的真实可达性靠真机，这里只覆盖纯逻辑分支，涉及 chrome 的按需 stub。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pageInjectionBlockReason, userScriptsUnavailableMessage } from './element-picker-client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('userScripts 不可用引导文案', () => {
  it('说明是哪个开关（用户能对上浏览器里的那一项）', () => {
    const msg = userScriptsUnavailableMessage()
    expect(msg).toContain('允许运行用户脚本')
  })

  it('三个能力都点名（件同时服务拾取 / 快照 / 环境读数）', () => {
    const msg = userScriptsUnavailableMessage()
    expect(msg).toContain('拾取元素')
    expect(msg).toContain('读快照')
    expect(msg).toContain('读环境')
  })
})

// —— 不可注入页面的前置判据（活动标签是工作台时点「点选元素」，Chrome 的英文报错
//    「Extension manifest must request permission to access this host」原样漏给了用户）——
describe('pageInjectionBlockReason（可注入性前置判据）', () => {
  it('普通网页：可注入（null）', () => {
    expect(pageInjectionBlockReason('https://example.com/a')).toBeNull()
    expect(pageInjectionBlockReason('http://localhost:3000/')).toBeNull()
  })

  it('URL 拿不到时不拦（tab.url 为空，交注入这一步去判）', () => {
    expect(pageInjectionBlockReason(undefined)).toBeNull()
    expect(pageInjectionBlockReason('')).toBeNull()
  })

  it('浏览器内置页：拦下并说明是内置页', () => {
    expect(pageInjectionBlockReason('chrome://extensions/')).toContain('内置页')
    expect(pageInjectionBlockReason('about:blank')).toContain('内置页')
  })

  it('本扩展自己的页面：拦下并指名「哆灵自己的页面」（用户才知道自己干了啥）', () => {
    vi.stubGlobal('chrome', {
      runtime: { id: 'EXTID', getURL: (p: string) => `chrome-extension://EXTID/${p}` },
    })
    const reason = pageInjectionBlockReason('chrome-extension://EXTID/workbench.html')
    expect(reason).toContain('哆灵自己的页面')
  })

  it('其他扩展的页面：拦下，但不说成自己的页面', () => {
    vi.stubGlobal('chrome', {
      runtime: { id: 'EXTID', getURL: (p: string) => `chrome-extension://EXTID/${p}` },
    })
    const reason = pageInjectionBlockReason('chrome-extension://OTHER/panel.html')
    expect(reason).toContain('其他扩展的页面')
  })
})
