import { parse } from 'acorn'
import { describe, expect, it } from 'vitest'
import { ALWAYS_GLOBALS, ALWAYS_NS, type GmInfo, gmAllGlobals, gmAllNs } from '@duoling/shared'
import { GM_WRAPPER_SUFFIX, buildGmWrapperPrefix, resolveGmExposure } from './index'
const EXTENSION_NAME = '测试扩展'

function info(): Omit<GmInfo, 'userAgent' | 'isIncognito'> {
  return {
    script: {
      name: '测试脚本',
      matches: ['https://example.com/*'],
      includes: [],
      excludes: [],
      runAt: 'document-end',
      grant: [],
      requires: [],
      resources: {},
    },
    scriptMetaStr: '',
    scriptHandler: EXTENSION_NAME,
    version: '0.0.0-test',
    uuid: 'u-test',
    sandboxMode: 'raw',
    downloadMode: 'browser',
  }
}

function build(grant?: string[], body?: string): string {
  return (
    buildGmWrapperPrefix({
      uuid: 'u-test',
      name: '测试脚本',
      values: { k: 'v', n: 1 },
      info: info(),
      pageSecret: 'secret',
      ...(grant ? { grant } : {}),
    }) +
    (body ? '\n' + body + '\n' : '') +
    GM_WRAPPER_SUFFIX
  )
}

describe('buildGmWrapperPrefix', () => {
  it('产出的注入源码语法合法（acorn 解析；含内联的桥客户端）', () => {
    const src = build()
    expect(() => parse(src, { ecmaVersion: 'latest' })).not.toThrow()
    expect(src).not.toContain('${')
    expect(src).not.toContain('\\`')
  })

  it('靠下行帧的命令都先等通道（否则帧无处可推，回调静默永不触发）', () => {
    const src = build()
    expect(src).toContain('wantsProgress ? __gmSendAfterChannel : __gmSend')
    expect(src).toContain('wantsFrames ? __gmSendAfterChannel : __gmSend')
    expect(src).toContain('typeof onclick === "function" ? __gmSendAfterChannel : __gmSend')
    expect(src).toContain('下行通道未就绪，本次调用的进度 / 完成回调会收不到')
  })

  it('文本体也在这里挂上 body（init 字面量不含 body 字段，漏了就整段丢）', () => {
    const src = build()
    expect(src).toContain('if (typeof raw === "string") return Promise.resolve(function(s) {')
  })

  it('嵌入了值快照、GM_info 与按 grant 算出的成员表', () => {
    const src = build(['GM_getValue'])
    expect(src).toContain(`"scriptHandler":"${EXTENSION_NAME}"`)
    expect(src).toContain('"GM_getValue":true')
    expect(src).toContain('"GM_setValue":false')
  })

  it('userAgent / isIncognito 由运行时就地补齐（注册侧拿不到页面 UA）', () => {
    const src = build()
    expect(src).toContain('GM_INFO.userAgent = navigator.userAgent')
    expect(src).toContain('inIncognitoContext')
  })

  it('MAIN 世界的成员都显式实现（unsafeWindow 即页面 window / onurlchange / cookie 字段校验收窄）', () => {
    const src = build()
    expect(src).toContain('var unsafeWindow = window')
    expect(src).not.toContain("defineProperty(window, 'unsafeWindow'")
    expect(src).toContain('Object.defineProperty(window, "onurlchange"')
    expect(src).toContain('domain: q.domain, path: q.path')
  })

  it('urlchange 走本地检测：hook history + popstate / hashchange，不再经 SW 订阅', () => {
    const src = build()
    expect(src).toContain('Object.defineProperty(window, "onurlchange"')
    expect(src).toContain('history.pushState =')
    expect(src).toContain('history.replaceState =')
    expect(src).toContain('addEventListener("popstate"')
    expect(src).toContain('addEventListener("hashchange"')
    expect(src).not.toContain('c: "url.watch"')
    expect(src).not.toContain('c: "url.unwatch"')
  })

  it('前缀与脚本正文的拼接分号安全：正文以 ( 开头时不被 ASI 并进上一条语句（真机回归）', () => {
    const body = [
      '// ==UserScript==',
      '// @name 分号回归',
      '// ==/UserScript==',
      '(function () {})()',
      '//# sourceURL=asi-regression.js',
    ].join('\n')
    const src = build([], body)
    expect(src).toContain('window.addEventListener("hashchange", __gmCheckUrl);')
    const program = parse(src, { ecmaVersion: 'latest' }) as unknown as {
      body: Array<{
        type: string
        expression?: { callee: { body: { body: unknown[] } } }
      }>
    }
    const iife = program.body.filter((s) => s.type === 'ExpressionStatement')[0]!
    const inner = iife.expression!.callee.body.body
    const tryStmt = inner[inner.length - 1] as {
      type: string
      block?: { body: unknown[] }
      handler?: { type: string }
    }
    expect(tryStmt.type).toBe('TryStatement')
    expect(tryStmt.handler!.type).toBe('CatchClause')
    const tryBody = tryStmt.block!.body as Array<{
      expression?: { callee?: { type: string } }
      type: string
    }>
    const last = tryBody[tryBody.length - 1]
    expect(last.type).toBe('ExpressionStatement')
    expect(last.expression!.callee!.type).toBe('FunctionExpression')
  })

  it('错误归属口径：正文包 try（catch 直报）、异步监听按本脚本 sourceURL 标记过滤', () => {
    const src = build()
    expect(GM_WRAPPER_SUFFIX).toContain('__gmReportCaught(e)')
    expect(src).toContain('duoling://script/u-test/')
    const guardCount = src.split('__gmOwnStack(').length - 1
    expect(guardCount).toBe(3)
    expect(src).toMatch(/if \(!__gmOwnStack\(stack\)\) return;?[^\n]*\n\s*__gmReportError/)
  })
})

describe('resolveGmExposure（@grant 裁剪）', () => {
  it('未声明 / 空 / @grant none → 只给恒注入集（对齐 TM：三种都不开 GM 成员）', () => {
    const always = [...ALWAYS_GLOBALS, ...ALWAYS_NS].sort()
    for (const grant of [undefined, [], ['none']]) {
      const flags = resolveGmExposure(grant)
      const on = Object.entries(flags)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .sort()
      expect(on, JSON.stringify(grant)).toEqual(always)
    }
  })

  it('声明了清单 → 只开清单内的能力（一对 grant 同时开全局与 GM.* 两形态）', () => {
    const flags = resolveGmExposure(['GM_getValue'])
    expect(flags.GM_getValue).toBe(true)
    expect(flags.getValue).toBe(true)
    expect(flags.GM_setValue).toBe(false)
    expect(flags.setValue).toBe(false)
    expect(flags.GM_cookie).toBe(false)
    expect(flags.GM_xmlhttpRequest).toBe(false)
  })

  it('恒注入集不受 grant 影响：GM_info / unsafeWindow / info', () => {
    const flags = resolveGmExposure(['GM_getValue'])
    for (const name of ['GM_info', 'unsafeWindow', 'info']) {
      expect(flags[name], name).toBe(true)
    }
  })

  it('未知 grant 名静默忽略（脚本用了会 ReferenceError，比假装支持好排查）', () => {
    const flags = resolveGmExposure(['GM_webRequest', 'GM_setValue'])
    expect(flags.GM_setValue).toBe(true)
    expect(flags).not.toHaveProperty('GM_webRequest')
  })

  it('点号形态的 grant 名也认，且只开 GM.* 那一形态（外部油猴脚本会写 GM.setValue）', () => {
    const flags = resolveGmExposure(['GM.setValue'])
    expect(flags.setValue).toBe(true)
    expect(flags.GM_setValue).toBe(false)
    expect(flags.GM_getValue).toBe(false)
  })

  it('两张名单不重名（注入体按名直查一张扁平表的前提）', () => {
    const overlap = gmAllGlobals().filter((n) => gmAllNs().includes(n))
    expect(overlap).toEqual([])
  })
})
