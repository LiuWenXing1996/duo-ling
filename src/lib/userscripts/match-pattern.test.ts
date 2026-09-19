// match-pattern.ts 单测：cookie 域名门的纯逻辑（scheme + host 判定，**忽略 path**）。
import { describe, expect, it } from 'vitest'
import {
  matchPatternCoversUrl,
  parseMatchPattern,
  urlInCookieScope,
} from './match-pattern'

describe('parseMatchPattern', () => {
  it('解析 scheme 与 host，丢掉 path', () => {
    expect(parseMatchPattern('https://example.com/foo/*')).toEqual({ scheme: 'https', host: 'example.com' })
    expect(parseMatchPattern('*://*.example.com/a/b/*')).toEqual({ scheme: '*', host: '*.example.com' })
  })

  it('<all_urls> 等价于任意 scheme + 任意 host', () => {
    expect(parseMatchPattern('<all_urls>')).toEqual({ scheme: '*', host: '*' })
  })

  it('非法 pattern 返回 null', () => {
    for (const bad of ['example.com/*', 'https:example.com/', 'https://', '']) {
      expect(parseMatchPattern(bad)).toBeNull()
    }
  })
})

describe('matchPatternCoversUrl · scheme + host', () => {
  it('**忽略 pattern 的 path 段**：只注入 /foo/ 的脚本也能覆盖站点根', () => {
    // 核心用例（老大 2026-09-19 拍板）：cookie 是 host 级作用域，path 不得收窄判定
    expect(matchPatternCoversUrl('https://example.com/foo/*', 'https://example.com/')).toBe(true)
    expect(matchPatternCoversUrl('https://example.com/foo/*', 'https://example.com/bar/baz?x=1')).toBe(true)
    expect(matchPatternCoversUrl('https://example.com/*', 'https://example.com/deep/path')).toBe(true)
  })

  it('scheme：* 覆盖 http 与 https，不覆盖其它', () => {
    expect(matchPatternCoversUrl('*://example.com/*', 'http://example.com/')).toBe(true)
    expect(matchPatternCoversUrl('*://example.com/*', 'https://example.com/')).toBe(true)
    expect(matchPatternCoversUrl('*://example.com/*', 'ftp://example.com/')).toBe(false)
    expect(matchPatternCoversUrl('*://example.com/*', 'file:///tmp/x')).toBe(false)
    expect(matchPatternCoversUrl('https://example.com/*', 'http://example.com/')).toBe(false)
  })

  it('host：*.example.com 覆盖域本身与任意层级子域，不覆盖形近域', () => {
    expect(matchPatternCoversUrl('*://*.example.com/*', 'https://example.com/')).toBe(true)
    expect(matchPatternCoversUrl('*://*.example.com/*', 'https://a.example.com/')).toBe(true)
    expect(matchPatternCoversUrl('*://*.example.com/*', 'https://a.b.example.com/')).toBe(true)
    expect(matchPatternCoversUrl('*://*.example.com/*', 'https://notexample.com/')).toBe(false)
    expect(matchPatternCoversUrl('*://*.example.com/*', 'https://example.com.evil.test/')).toBe(false)
  })

  it('host：字面量精确匹配、大小写不敏感', () => {
    expect(matchPatternCoversUrl('https://example.com/*', 'https://example.com/')).toBe(true)
    expect(matchPatternCoversUrl('https://example.com/*', 'https://Example.COM/')).toBe(true)
    expect(matchPatternCoversUrl('https://example.com/*', 'https://sub.example.com/')).toBe(false)
  })

  it('host：* 覆盖任意 host（含端口；端口不参与判定）', () => {
    expect(matchPatternCoversUrl('<all_urls>', 'https://any.host.test/x')).toBe(true)
    expect(matchPatternCoversUrl('*://*/*', 'http://127.0.0.1:8443/')).toBe(true)
    expect(matchPatternCoversUrl('https://example.com/*', 'https://example.com:8443/')).toBe(true)
  })

  it('非 http(s) 的 url 一律不匹配（cookie 只对 http(s) 有意义）', () => {
    for (const url of ['chrome-extension://abc/x', 'data:text/html,x', 'about:blank', 'not a url']) {
      expect(matchPatternCoversUrl('<all_urls>', url)).toBe(false)
    }
  })

  it('非法 pattern 不匹配任何 url', () => {
    expect(matchPatternCoversUrl('example.com/*', 'https://example.com/')).toBe(false)
  })
})

describe('urlInCookieScope', () => {
  const scope = {
    matches: ['*://*.example.com/*', 'https://other.test/only/this/*'],
    excludeMatches: ['*://admin.example.com/*'],
  }

  it('命中任一 matches 即可（不与其它脚本取并集）', () => {
    expect(urlInCookieScope(scope, 'https://api.example.com/v1')).toBe(true)
    expect(urlInCookieScope(scope, 'https://other.test/')).toBe(true) // path 不收窄
  })

  it('命中 excludeMatches 即拒', () => {
    expect(urlInCookieScope(scope, 'https://admin.example.com/')).toBe(false)
  })

  it('域外即拒', () => {
    expect(urlInCookieScope(scope, 'https://evil.test/')).toBe(false)
  })

  it('matches 为空 / 缺省 → 恒拒（没有注入面就没有 cookie 访问权）', () => {
    expect(urlInCookieScope({ matches: [] }, 'https://example.com/')).toBe(false)
    expect(urlInCookieScope({}, 'https://example.com/')).toBe(false)
  })
})
