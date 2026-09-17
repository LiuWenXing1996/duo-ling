// match-pattern.ts 单测：@match 规则编译与 URL 匹配（纯函数，无 chrome 依赖）。
import { describe, expect, it } from 'vitest'
import { matchPatternToRegExp, matchesAnyPattern, urlMatchesPattern } from './match-pattern'

describe('matchPatternToRegExp', () => {
  it('非法 pattern 返回 null（不 throw）', () => {
    expect(matchPatternToRegExp('not-a-pattern')).toBeNull()
    expect(matchPatternToRegExp('http://')).toBeNull()
    expect(matchPatternToRegExp('*://')).toBeNull()
    // host 通配仅 http(s) 合法
    expect(matchPatternToRegExp('file://*/*')).toBeNull()
    // 空 host 仅 file/ftp 合法
    expect(matchPatternToRegExp('https:///*')).toBeNull()
  })

  it('<all_urls> 命中 http/https/file/ftp', () => {
    const re = matchPatternToRegExp('<all_urls>')
    expect(re).not.toBeNull()
    expect(re!.test('https://a.com/x')).toBe(true)
    expect(re!.test('http://a.com')).toBe(true)
    expect(re!.test('file:///etc/hosts')).toBe(true)
    expect(re!.test('chrome://extensions')).toBe(false)
  })
})

describe('urlMatchesPattern', () => {
  const cases: Array<[string, string, boolean]> = [
    // host 精确
    ['https://example.com/', 'https://example.com/*', true],
    ['https://example.com/a/b', 'https://example.com/*', true],
    ['https://sub.example.com/', 'https://example.com/*', false],
    ['https://badexample.com/', 'https://example.com/*', false], // 后缀不算子域
    // '*.' 基域 + 子域
    ['https://example.com/', '*://*.example.com/*', true],
    ['https://a.b.example.com/', '*://*.example.com/*', true],
    ['https://notexample.com/', '*://*.example.com/*', false],
    // scheme '*' = http + https，不含 ftp
    ['https://a.com/', '*://a.com/*', true],
    ['http://a.com/', '*://a.com/*', true],
    ['ftp://a.com/', '*://a.com/*', false],
    // path 通配
    ['https://a.com/x/y', 'https://a.com/x/*', true],
    ['https://a.com/x', 'https://a.com/x/*', false], // path 必须完整匹配
    ['https://a.com/any', 'https://a.com/*', true],
    // host 通配 '*'
    ['https://anything.org/', 'https://*/*', true],
    // file 方案无 host
    ['file:///C:/tmp/x.html', 'file:///*', true],
    // 大小写不敏感（scheme/host）
    ['HTTPS://EXAMPLE.COM/A', 'https://example.com/*', true],
  ]
  it.each(cases)('%s vs %s → %s', (url, pattern, expected) => {
    expect(urlMatchesPattern(url, pattern)).toBe(expected)
  })
})

describe('matchesAnyPattern', () => {
  it('任一命中即真，全不命中为假，非法 URL 为假', () => {
    expect(matchesAnyPattern('https://a.com/', ['https://b.com/*', 'https://a.com/*'])).toBe(true)
    expect(matchesAnyPattern('https://a.com/', ['https://b.com/*'])).toBe(false)
    expect(matchesAnyPattern('::not-a-url::', ['<all_urls>'])).toBe(false)
    expect(matchesAnyPattern('chrome://extensions', ['<all_urls>'])).toBe(false)
    expect(matchesAnyPattern('https://a.com/', [])).toBe(false)
  })
})
