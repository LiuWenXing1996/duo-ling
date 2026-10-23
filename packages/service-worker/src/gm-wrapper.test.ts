// gm-wrapper 单测：防漂移断言反射运行时源码（?raw 直取）；产物字节只做 parse 冒烟（引号统一成双引号，不做文本断言）。
import { parse } from 'acorn'
import { describe, expect, it } from 'vitest'
import { ALWAYS_GLOBALS, ALWAYS_NS, type GmInfo, gmAllGlobals, gmAllNs } from '@duoling/shared'
import { GM_WRAPPER_IIFE, buildGmWrapperInit, resolveGmExposure } from './gm-wrapper'
import runtimeSrc from './gm-wrapper-runtime.ts?raw'

/** 测试自造：断言生成源码里的 scriptHandler 跟随传入值。真值由应用侧传入，包内不持有。 */
const EXTENSION_NAME = '测试扩展'

/** 造一份最小 GM_info（userAgent / isIncognito 由包装运行时就地补，故不传） */
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
    GM_WRAPPER_IIFE +
    '\n' +
    buildGmWrapperInit(
      {
        uuid: 'u-test',
        name: '测试脚本',
        values: { k: 'v', n: 1 },
        info: info(),
        pageSecret: 'secret',
        ...(grant ? { grant } : {}),
      },
      body ?? '',
    )
  )
}

describe('GM 包装注入体', () => {
  it('产出的注入源码语法合法（acorn 解析；产物含内联的桥客户端与共享 digest）', () => {
    const src = build()
    expect(() => parse(src, { ecmaVersion: 'latest' })).not.toThrow()
    expect(src).toContain('__duolingGmInstall')
  })

  it('靠下行帧的命令都先等通道（否则帧无处可推，回调静默永不触发）', () => {
    // fetch 的 onprogress、download 的三个回调、notify 的 onclick —— 都靠 Port 推帧，而
    // __gmSend 只管请求-应答、不建通道。曾经三处都用 __gmSend 直发：请求 / 下载本身成功，
    // 但回调全被静默丢掉（真机实测）。
    expect(runtimeSrc).toContain('wantsProgress ? __gmSendAfterChannel : __gmSend')
    expect(runtimeSrc).toContain('wantsFrames ? __gmSendAfterChannel : __gmSend')
    expect(runtimeSrc).toContain("typeof onclick === 'function' ? __gmSendAfterChannel : __gmSend")
    // 降级而不阻断：通道建不起来也要把请求发出去，但必须在控制台喊一声（不做新的静默失败）
    expect(runtimeSrc).toContain('下行通道未就绪，本次调用的进度 / 完成回调会收不到')
  })

  it('文本体也在 __gmEncodeBody 挂上 body（曾经 string data 被当「没有体」直接返回、init 字面量也无 body 字段，两头都不带，POST 文本体在过桥前就没了）', () => {
    expect(runtimeSrc).toContain("typeof raw === 'string'")
    expect(runtimeSrc).toContain('c.body = raw')
  })

  it('装配段内联了值快照、GM_info 与按 grant 算出的成员表', () => {
    const src = build(['GM_getValue'])
    expect(src).toContain('"k":"v"') // 值快照
    expect(src).toContain(`"scriptHandler":"${EXTENSION_NAME}"`)
    expect(src).toContain('"GM_getValue":true')
    expect(src).toContain('"GM_setValue":false')
  })

  it('userAgent / isIncognito 由运行时就地补齐（注册侧拿不到页面 UA）', () => {
    expect(runtimeSrc).toContain('GM_INFO.userAgent = navigator.userAgent')
    expect(runtimeSrc).toContain('inIncognitoContext')
  })

  it('MAIN 世界的成员都显式实现（unsafeWindow 即页面 window，经装配段解构成局部变量）', () => {
    expect(runtimeSrc).toContain('members.unsafeWindow = window')
    expect(runtimeSrc).not.toContain("defineProperty(window, 'unsafeWindow'")
    expect(runtimeSrc).toContain("Object.defineProperty(window, 'onurlchange'")
    // cookie 的三个方法都照 TM 收 domain / path（url 恒参与查询，domain / path 只收窄可见范围）
    expect(runtimeSrc).toContain('domain: q.domain')
    expect(runtimeSrc).toContain('path: q.path')
    expect(runtimeSrc).toContain('store.watchAll')
    expect(runtimeSrc).toContain('store.all')
  })

  it('urlchange 走本地检测：hook history + popstate / hashchange，不再经 SW 订阅', () => {
    expect(runtimeSrc).toContain("Object.defineProperty(window, 'onurlchange'")
    expect(runtimeSrc).toContain('history.pushState =')
    expect(runtimeSrc).toContain('history.replaceState =')
    expect(runtimeSrc).toContain("addEventListener('popstate'")
    expect(runtimeSrc).toContain("addEventListener('hashchange'")
    // 脚本与页面同处一个世界，路由变化自己就能听见 —— 跨世界订阅整条撤掉，
    // 也顺带免掉了「覆盖 window.addEventListener 做本地转发」对页面的侵入
    expect(runtimeSrc).not.toContain("c: 'url.watch'")
    expect(runtimeSrc).not.toContain("c: 'url.unwatch'")
  })

  it('装配段与正文的拼接分号安全：正文以 ( 开头时不被 ASI 并进上一条语句（真机回归：合并后语法合法、parse 不报错，但正文 IIFE 不再是独立语句，正文从未执行）', () => {
    const body = [
      '// ==UserScript==',
      '// @name 分号回归',
      '// ==/UserScript==',
      '(function () {})()',
      '//# sourceURL=asi-regression.js',
    ].join('\n')
    const src = build([], body)
    // 防合并的守卫在装配段：以防御性分号开头，前一段（产物 / @require）结尾缺分号也不会被 ASI 并句
    expect(src).toContain('\n;(function () {')
    const program = parse(src, { ecmaVersion: 'latest' }) as unknown as {
      body: Array<{ type: string; expression?: any }>
    }
    const stmts = program.body.filter((s) => s.type === 'ExpressionStatement')
    const assembly = stmts[stmts.length - 1]!.expression
    expect(assembly.callee.type).toBe('FunctionExpression')
    const asmBody = assembly.callee.body.body
    const runCall = asmBody[asmBody.length - 1].expression
    expect(runCall.callee.property.name).toBe('runBody')
    const bodyFn = runCall.arguments[0]
    expect(bodyFn.type).toBe('FunctionExpression')
    const last = bodyFn.body.body[bodyFn.body.body.length - 1]
    expect(last.type).toBe('ExpressionStatement')
    expect(last.expression.callee.type).toBe('FunctionExpression')
  })

  it('错误归属口径：正文包 try（catch 直报）、异步监听按本脚本 sourceURL 标记过滤', () => {
    expect(runtimeSrc).toContain('__gmReportCaught(e)')
    // 异步层：两个全局监听都先判栈，标记含本脚本 uuid（多脚本同页互不冒领）
    expect(runtimeSrc).toContain('duoling://script/')
    const guardCount = runtimeSrc.split('__gmOwnStack(').length - 1
    // 1 处定义 + error / unhandledrejection 两个监听各守一次
    expect(guardCount).toBe(3)
    // 过滤必须发生在上报之前（守卫在 __gmReportError 调用前面）：直接断言监听体形状
    expect(runtimeSrc).toMatch(/if \(!__gmOwnStack\(stack\)\) return\n\s*__gmReportError/)
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
