// logic 单测：float-panel-host —— 「这个标签页能不能挂浮层」的域名判据。
//
// 要点在**扩展页**：`chrome-extension://<id>/workbench.html` 的 hostname 就是扩展自己的 id ——
// 谁直接拿 hostname 当站点，就会把这串 id 当成一个「网站」显示。这条必须钉住。
import { describe, expect, it } from 'vitest'
import { webHostname } from './float-panel-host'

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
