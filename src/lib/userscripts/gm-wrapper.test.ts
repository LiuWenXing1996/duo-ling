// gm-wrapper 单测：① 注入源码**必须能解析**（它是字符串，语法错一次就静默全废）；
// ② `@grant` 裁剪规则按预期放行 / 关闭成员。
import { parse } from 'acorn'
import { describe, expect, it } from 'vitest'
import { ALWAYS_GLOBALS, ALWAYS_NS, GM_ALL_GLOBALS, GM_ALL_NS } from '../gm-grants'
import type { GmInfo } from './api-contract'
import { GM_WRAPPER_SUFFIX, buildGmWrapperPrefix, resolveGmExposure } from './gm-wrapper'

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
    scriptHandler: '哆灵',
    version: '0.0.0-test',
    uuid: 'u-test',
    sandboxMode: 'raw',
  }
}

/** 产出**完整**的注入 code：engine 那边由「包装前缀 ＋ @require ＋ 脚本源码 ＋ 闭合后缀」拼成 */
function build(grant?: string[]): string {
  return (
    buildGmWrapperPrefix({
      uuid: 'u-test',
      name: '测试脚本',
      values: { k: 'v', n: 1 },
      info: info(),
      pageSecret: 'secret',
      ...(grant ? { grant } : {}),
    }) + GM_WRAPPER_SUFFIX
  )
}

describe('buildGmWrapperPrefix', () => {
  it('产出的注入源码语法合法（acorn 解析；含内联的桥客户端与 GM.page 本地实现）', () => {
    const src = build()
    expect(() => parse(src, { ecmaVersion: 'latest' })).not.toThrow()
    // 模板体里绝不能残留未闭合的模板痕迹（反引号一旦漏进注入体，整份源码就废了）
    expect(src).not.toContain('${')
    expect(src).not.toContain('\\`')
  })

  it('嵌入了值快照、GM_info 与按 grant 算出的成员表', () => {
    const src = build(['GM_getValue'])
    expect(src).toContain('"k":"v"') // 值快照
    expect(src).toContain('"scriptHandler":"哆灵"')
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
    // unsafeWindow 就是页面自己的 window（脚本跑在主世界），故走局部声明
    expect(src).toContain('var unsafeWindow = window')
    expect(src).not.toContain("defineProperty(window, 'unsafeWindow'")
    expect(src).toContain("Object.defineProperty(window, 'onurlchange'")
    // cookie 的三个方法都照 TM 收 domain / path（url 恒参与查询，domain / path 只收窄可见范围）
    expect(src).toContain('domain: q.domain, path: q.path')
    expect(src).toContain('store.watchAll') // 常驻通道
    expect(src).toContain('store.all') // connect 后全量校准
  })

  it('urlchange 走本地检测：hook history + popstate / hashchange，不再经 SW 订阅', () => {
    const src = build()
    expect(src).toContain("Object.defineProperty(window, 'onurlchange'")
    expect(src).toContain('history.pushState =')
    expect(src).toContain('history.replaceState =')
    expect(src).toContain("addEventListener('popstate'")
    expect(src).toContain("addEventListener('hashchange'")
    // 脚本与页面同处一个世界，路由变化自己就能听见 —— 跨世界订阅整条撤掉，
    // 也顺带免掉了「覆盖 window.addEventListener 做本地转发」对页面的侵入
    expect(src).not.toContain("c: 'url.watch'")
    expect(src).not.toContain("c: 'url.unwatch'")
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

  it('恒注入集不受 grant 影响：GM_info / unsafeWindow / info / 本扩展成员', () => {
    const flags = resolveGmExposure(['GM_getValue'])
    for (const name of ['GM_info', 'unsafeWindow', 'info', 'clearValues', 'focusTab', 'page']) {
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
    const overlap = GM_ALL_GLOBALS.filter((n) => GM_ALL_NS.includes(n))
    expect(overlap).toEqual([])
  })
})
