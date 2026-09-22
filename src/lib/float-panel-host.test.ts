// logic 单测：float-panel-host —— 浮层设置用到的域名判据与输入转换。
//
// webHostname 的要点在**扩展页**：`chrome-extension://<id>/workbench.html` 的 hostname 就是
// 扩展自己的 id —— 谁直接拿 hostname 当站点，就会把这串 id 当成一个「网站」显示，还能写进
// 站点禁用集合。这条必须钉住。
// normalizeSitePattern 的要点是**输入宽容 + 语义默认**（纯域名 = 连子域一起关），
// sitePatternLabel 是它的反解，splitSiteInputs 管粘贴拆分。
import { describe, expect, it } from 'vitest'
import {
  normalizeSitePattern,
  sitePatternLabel,
  splitSiteInputs,
  webHostname,
} from './float-panel-host'

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

describe('normalizeSitePattern（用户输入 → match pattern）', () => {
  it('纯域名：连子域一起关（与 Chrome「网站设置」的 [*.] 默认一致）', () => {
    expect(normalizeSitePattern('example.com')).toBe('*://*.example.com/*')
    expect(normalizeSitePattern('  Example.COM  ')).toBe('*://*.example.com/*')
  })

  it('整条网址 / 带路径 / 带端口：只取站点，丢掉 scheme 与 path', () => {
    expect(normalizeSitePattern('https://www.a.com/x?y=1#z')).toBe('*://*.www.a.com/*')
    expect(normalizeSitePattern('http://a.com:8080/x')).toBe('*://*.a.com/*')
    expect(normalizeSitePattern('a.com/foo')).toBe('*://*.a.com/*')
  })

  it('显式 *. 前缀等价于纯域名；单标签 host 与 IPv4 不带 *.', () => {
    expect(normalizeSitePattern('*.example.com')).toBe('*://*.example.com/*')
    expect(normalizeSitePattern('localhost')).toBe('*://localhost/*')
    expect(normalizeSitePattern('127.0.0.1')).toBe('*://127.0.0.1/*')
  })

  it('认不出来的一律 null：非 http(s) 网址、单标签、非法片段、空', () => {
    expect(normalizeSitePattern('chrome-extension://abc/x')).toBeNull()
    expect(normalizeSitePattern('file:///tmp/x.html')).toBeNull()
    expect(normalizeSitePattern('intranet')).toBeNull()
    expect(normalizeSitePattern('exa mple.com')).toBeNull()
    expect(normalizeSitePattern('-bad.com')).toBeNull()
    expect(normalizeSitePattern('a..com')).toBeNull()
    expect(normalizeSitePattern('   ')).toBeNull()
  })
})

describe('sitePatternLabel / splitSiteInputs', () => {
  it('条目 → 展示用域名：去掉 scheme、path 与 *. 前缀', () => {
    expect(sitePatternLabel('*://*.example.com/*')).toBe('example.com')
    expect(sitePatternLabel('*://localhost/*')).toBe('localhost')
    expect(sitePatternLabel('*://127.0.0.1/*')).toBe('127.0.0.1')
  })

  it('历史裸 hostname 条目原样显示（它不是合法 pattern）', () => {
    expect(sitePatternLabel('www.example.com')).toBe('www.example.com')
  })

  it('粘贴拆分：换行 / 逗号 / 分号 / 空格都当分隔，空项丢掉', () => {
    expect(splitSiteInputs('a.com\nb.com, c.com；d.com; e.com')).toEqual([
      'a.com',
      'b.com',
      'c.com',
      'd.com',
      'e.com',
    ])
    expect(splitSiteInputs('  \n  ')).toEqual([])
  })
})
