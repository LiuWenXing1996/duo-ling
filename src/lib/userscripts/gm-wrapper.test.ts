// gm-wrapper 单测：① 注入源码**必须能解析**（它是字符串，语法错一次就静默全废）；
// ② `@grant` 裁剪规则按预期放行 / 关闭成员。
import { parse } from 'acorn'
import { describe, expect, it } from 'vitest'
import { GM_ALL_GLOBALS, GM_ALL_NS } from '../gm-grants'
import type { GmInfo } from './api-contract'
import { buildGmWrapperSource, resolveGmExposure } from './gm-wrapper'

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
    sandboxMode: 'js',
  }
}

function build(grant?: string[]): string {
  return buildGmWrapperSource({
    uuid: 'u-test',
    name: '测试脚本',
    values: { k: 'v', n: 1 },
    info: info(),
    pageSecret: 'secret',
    ...(grant ? { grant } : {}),
  })
}

describe('buildGmWrapperSource', () => {
  it('产出的注入源码语法合法（acorn 解析；含内联的 page-client 客户端）', () => {
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

  it('降级与差异项都被显式实现（unsafeWindow / onurlchange / 域名门收紧）', () => {
    const src = build()
    expect(src).toContain("Object.defineProperty(window, 'unsafeWindow'")
    expect(src).toContain("Object.defineProperty(window, 'onurlchange'")
    expect(src).toContain('domain / path 不受支持')
    expect(src).toContain('store.watchAll') // 常驻通道
    expect(src).toContain('store.all') // connect 后全量校准
  })

  it('onurlchange 的退订路径在（摘干净 → 复位意图位 + 发 url.unwatch）', () => {
    const src = build()
    // 订阅侧两条路（属性赋值 / addEventListener）都在
    expect(src.match(/c: 'url\.watch'/g)?.length).toBeGreaterThanOrEqual(3)
    // 退订侧：复位意图位 + 通知后台。不复位的后果是**注销不掉** —— 意图位一直为 true，
    // Port 重连时 __gmConnect 会无条件重放 url.watch（见上面 rreqs 那段）
    expect(src).toContain("c: 'url.unwatch'")
    expect(src).toContain('__gmActiveUrlWatch = false')
    // 释放函数 = 定义 1 处 + 两条退订路（属性置 null / removeEventListener）各 1 处
    expect(src.match(/__gmReleaseUrlWatchIfIdle\(\)/g)?.length, '退订没接全（少了一处调用？）').toBe(3)
  })
})

describe('resolveGmExposure（@grant 裁剪）', () => {
  const ALL = [...GM_ALL_GLOBALS, ...GM_ALL_NS]

  it('未声明 / 空 / @grant none → 全量注入', () => {
    for (const grant of [undefined, [], ['none']]) {
      const flags = resolveGmExposure(grant)
      expect(Object.values(flags).filter(Boolean)).toHaveLength(ALL.length)
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

  it('两张名单不重名（注入体按名直查一张扁平表的前提）', () => {
    const overlap = GM_ALL_GLOBALS.filter((n) => GM_ALL_NS.includes(n))
    expect(overlap).toEqual([])
  })
})
