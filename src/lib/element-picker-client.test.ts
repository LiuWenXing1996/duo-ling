// 元素拾取发起侧封装的纯函数 / 判据测试（验收：
// 「拾取期间用户关闭 / 导航页面 → 60 秒超时视为取消并明确提示（超时逻辑单测覆盖）」）。
// chrome API 的真实可达性靠真机（前置探针 tmp/probe-v4.mjs、tmp/probe-open-extensions-page.mjs）；
// 本文件只覆盖纯逻辑分支，涉及 chrome 的按需 stub。
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  friendlyInjectError,
  pageInjectionBlockReason,
  userScriptsUnavailableMessage,
  withTimeout
} from './element-picker-client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('withTimeout（超时兜底）', () => {
  it('先于超时完成：返回原值', async () => {
    const v = await withTimeout(Promise.resolve('ok'), 1000, '超时')
    expect(v).toBe('ok')
  })

  it('永不结算：按文案超时拒绝（页面关掉后注入 Promise 挂死的兜底）', async () => {
    await expect(withTimeout(new Promise(() => {}), 20, '拾取已取消：超时')).rejects.toThrow(
      '拾取已取消：超时',
    )
  })

  it('底层先失败：透传原始错误', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('注入失败')), 1000, '超时'),
    ).rejects.toThrow('注入失败')
  })

  it('非 Error 的底层拒绝值：包装为 Error 透传', async () => {
    await expect(withTimeout(Promise.reject('boom'), 1000, '超时')).rejects.toThrow('boom')
  })
})

describe('userScripts 不可用引导文案', () => {
  it('给出用户可执行的指引（说明是哪个开关 + 指到引导页看步骤）', () => {
    const msg = userScriptsUnavailableMessage()
    expect(msg).toContain('允许运行用户脚本')
    expect(msg).toContain('引导')
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
    vi.stubGlobal('chrome', { runtime: { id: 'EXTID', getURL: (p: string) => `chrome-extension://EXTID/${p}` } })
    const reason = pageInjectionBlockReason('chrome-extension://EXTID/workbench.html')
    expect(reason).toContain('哆灵自己的页面')
  })

  it('其他扩展的页面：拦下，但不说成自己的页面', () => {
    vi.stubGlobal('chrome', { runtime: { id: 'EXTID', getURL: (p: string) => `chrome-extension://EXTID/${p}` } })
    const reason = pageInjectionBlockReason('chrome-extension://OTHER/panel.html')
    expect(reason).toContain('其他扩展的页面')
  })
})

describe('friendlyInjectError（Chrome 英文报错归一）', () => {
  it('权限类报错：换成用户可读文案，不出现英文原话', () => {
    const raw =
      'Cannot access contents of url "chrome-extension://EXTID/workbench.html". ' +
      'Extension manifest must request permission to access this host.'
    const msg = friendlyInjectError(new Error(raw)).message
    expect(msg).toContain('不支持哆灵')
    expect(msg).toContain('允许访问文件网址')
    expect(msg).not.toContain('manifest')
  })

  it('其他错误：原样透传（超时 / 取消这类文案不能被吞掉）', () => {
    expect(friendlyInjectError(new Error('拾取已取消：60 秒内未完成点选')).message).toBe(
      '拾取已取消：60 秒内未完成点选',
    )
  })

  it('非 Error 值：包装成 Error', () => {
    expect(friendlyInjectError('boom').message).toBe('boom')
  })
})
