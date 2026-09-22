// metadata 解析器（metadata.ts）单测。
//
// 关注两件事（都是「标准油猴脚本能直接跑」的前提）：
//   ① 解析忠实：TM 的取值规则（首个块、单值键首次胜、本地化后缀忽略）；
//   ② 产出的 match pattern **一定是 Chrome 会接受的**：项目自己的 MATCH_PATTERN_RE 有个已知宽松点
//      （host 段可为空 → `*:///foo/*` 被判合法），解析器必须绕开它，否则错误会拖到注册期才以英文异常冒出。
import { describe, expect, it } from 'vitest'
import {
  applyMetadataToConfig,
  parseUserScriptMetadata,
  resolveConfigFromSource,
} from './metadata'
import type { ParsedMetadata } from './metadata'
import { isValidMatchPattern } from './project-store'
import { parseMatchPattern } from '@/lib/match-pattern'
import { defaultConfig } from './types'

/** 造一个解析产物（只填关心的字段） */
function mk(patch: Partial<ParsedMetadata>): ParsedMetadata {
  return {
    raw: '',
    matches: [],
    includes: [],
    excludes: [],
    noframes: false,
    grants: [],
    requires: [],
    resources: [],
    connects: [],
    ...patch,
  }
}

/** 断言一组 pattern 都是 Chrome 安全的（合法 + host 非空） */
function expectChromeSafe(patterns: string[]): void {
  for (const p of patterns) {
    expect(isValidMatchPattern(p), `${p} 不是合法 match pattern`).toBe(true)
    expect(parseMatchPattern(p)?.host ?? '', `${p} 的 host 段为空（Chrome 会拒绝）`).not.toBe('')
  }
}

const FULL_BLOCK = `// ==UserScript==
// @name         示例脚本
// @namespace    https://example.com/ns
// @version      1.2.3
// @description  一句话说明
// @author       某人
// @icon         https://example.com/i.png
// @match        https://example.com/*
// @include      https://other.example.org/foo/*
// @exclude      https://example.com/private/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_getValue
// @require      https://cdn.example.com/a.js
// @resource     jq https://cdn.example.com/jquery.js
// @connect      api.example.com
// @noframes
// ==/UserScript==

console.log('hi')
`

describe('parseUserScriptMetadata', () => {
  it('没有 metadata 块时返回 null（无 metadata 是正常形态）', () => {
    expect(parseUserScriptMetadata('console.log(1)')).toBeNull()
    expect(parseUserScriptMetadata('// 只有注释\n// @match *://*/*')).toBeNull()
  })

  it('解析全部键，且多有值键按出现顺序累积', () => {
    const m = parseUserScriptMetadata(FULL_BLOCK)!
    expect(m.name).toBe('示例脚本')
    expect(m.namespace).toBe('https://example.com/ns')
    expect(m.version).toBe('1.2.3')
    expect(m.description).toBe('一句话说明')
    expect(m.author).toBe('某人')
    expect(m.icon).toBe('https://example.com/i.png')
    expect(m.runAtRaw).toBe('document-start')
    expect(m.matches).toEqual(['https://example.com/*'])
    expect(m.includes).toEqual(['https://other.example.org/foo/*'])
    expect(m.excludes).toEqual(['https://example.com/private/*'])
    expect(m.grants).toEqual(['GM_getValue', 'GM_setValue']) // 保序去重
    expect(m.requires).toEqual(['https://cdn.example.com/a.js'])
    expect(m.resources).toEqual([{ name: 'jq', url: 'https://cdn.example.com/jquery.js' }])
    expect(m.connects).toEqual(['api.example.com'])
    expect(m.noframes).toBe(true)
    expect(m.raw.startsWith('// ==UserScript==')).toBe(true)
    expect(m.raw.endsWith('// ==/UserScript==')).toBe(true)
  })

  it('单值键：无后缀写法恒胜过本地化写法，同级首次出现者胜', () => {
    // 本地化在前，也要输给无后缀的 @name
    const m1 = parseUserScriptMetadata(`// ==UserScript==
// @name:zh-CN 中文名
// @name        英文名
// @name        第二个英文名
// ==/UserScript==`)!
    expect(m1.name).toBe('英文名')

    // 只有本地化写法时，用它兜底（不丢名字）
    const m2 = parseUserScriptMetadata('// ==UserScript==\n// @name:zh-CN 只有本地化\n// ==/UserScript==')!
    expect(m2.name).toBe('只有本地化')

    // 无后缀在前，后续本地化写法不覆盖
    const m3 = parseUserScriptMetadata(`// ==UserScript==
// @name        英文名
// @name:zh-CN 中文名
// ==/UserScript==`)!
    expect(m3.name).toBe('英文名')
  })

  it('兼容无空格的标记写法与 CRLF 换行', () => {
    const m = parseUserScriptMetadata('//==UserScript==\r\n// @name x\r\n//==/UserScript==\r\n')!
    expect(m.name).toBe('x')
  })

  it('只认第一个块（后面的块不参与）', () => {
    const m = parseUserScriptMetadata(`// ==UserScript==
// @name first
// ==/UserScript==
// ==UserScript==
// @name second
// ==/UserScript==`)!
    expect(m.name).toBe('first')
  })

  it('@noframes 是无值键：有它即 true，没有即 false', () => {
    expect(parseUserScriptMetadata('// ==UserScript==\n// @noframes\n// ==/UserScript==')!.noframes).toBe(true)
    expect(parseUserScriptMetadata('// ==UserScript==\n// @name a\n// ==/UserScript==')!.noframes).toBe(false)
  })
})

describe('applyMetadataToConfig', () => {
  it('@match 直通（含 <all_urls> 特例），且产出的 pattern 全部 Chrome 安全', () => {
    const r = applyMetadataToConfig(
      mk({ matches: ['https://example.com/*', '<all_urls>'] }),
      defaultConfig([]),
    )
    expect(r.config.matches).toEqual(['https://example.com/*', '<all_urls>'])
    expectChromeSafe(r.config.matches)
    expect(r.notes).toEqual([])
  })

  it('@include 省略 scheme 时补 *://（不降级为 glob）', () => {
    const r = applyMetadataToConfig(mk({ includes: ['*.example.com/*'] }), defaultConfig([]))
    expect(r.config.matches).toEqual(['*://*.example.com/*'])
    expect(r.config.includeGlobs).toBeUndefined()
    expectChromeSafe(r.config.matches)
  })

  it('@include 纯路径降为 glob、放宽 matches，并写入 notes（cookie 门连带放开的知情）', () => {
    const r = applyMetadataToConfig(mk({ includes: ['/foo/*'] }), defaultConfig([]))
    expect(r.config.matches).toEqual(['*://*/*'])
    expect(r.config.includeGlobs).toEqual(['*://*/foo/*'])
    expect(r.notes.join('\n')).toContain('任意站点')
    expect(r.notes.join('\n')).toContain('cookie 访问范围')
  })

  it('纯路径不产出空 host 的 pattern（项目校验器的已知宽松点须绕开）', () => {
    // 记录事实：项目校验器接受空 host 写法，但 Chrome 注册会拒 —— 解析器必须绕开它
    expect(isValidMatchPattern('*:///foo/*')).toBe(true)
    const r = applyMetadataToConfig(mk({ includes: ['/foo/*'] }), defaultConfig([]))
    expect(r.config.matches).not.toContain('*:///foo/*')
    expectChromeSafe(r.config.matches)
  })

  it('正则形态的 @include 被丢弃并说明（不静默）', () => {
    const r = applyMetadataToConfig(mk({ includes: ['/^https:\\/\\//'] }), defaultConfig([]))
    expect(r.config.includeGlobs).toBeUndefined()
    expect(r.notes.join('\n')).toContain('正则')
  })

  it('@exclude 走同一套转换：能转 match 的进 excludeMatches，纯路径进 excludeGlobs', () => {
    const r = applyMetadataToConfig(
      mk({ matches: ['https://example.com/*'], excludes: ['https://example.com/private/*', '/admin/*'] }),
      defaultConfig([]),
    )
    expect(r.config.excludeMatches).toEqual(['https://example.com/private/*'])
    expect(r.config.excludeGlobs).toEqual(['*://*/admin/*'])
    expectChromeSafe(r.config.excludeMatches!)
  })

  it('带端口 / 非法 host 的 @match 被忽略并说明（校验器的第二个宽松点）', () => {
    // 记录事实：项目校验器接受带端口的 host，但 match pattern 语法不表达端口，Chrome 会拒
    expect(isValidMatchPattern('https://example.com:8443/*')).toBe(true)
    expect(parseMatchPattern('https://example.com:8443/*')?.host).toBe('example.com:8443')

    const r = applyMetadataToConfig(
      mk({ matches: ['https://example.com:8443/*', 'https://ok.example.com/*'] }),
      defaultConfig([]),
    )
    expect(r.config.matches).toEqual(['https://ok.example.com/*'])
    expect(r.notes.join('\n')).toContain('@match 不合法')
  })

  it('未声明匹配规则时沿用 fallback（导入路径 fallback 为空 → 落「不匹配任何页面」）', () => {
    const keep = applyMetadataToConfig(mk({ name: '只有名字' }), defaultConfig(['https://a.example.com/*']))
    expect(keep.config.matches).toEqual(['https://a.example.com/*'])
    const empty = applyMetadataToConfig(mk({ name: '只有名字' }), defaultConfig([]))
    expect(empty.config.matches).toEqual([])
  })

  it('源码声明优先于 fallback（逐字段：声明了就采用，没声明才沿用）', () => {
    const r = applyMetadataToConfig(mk({ matches: ['https://x.example.com/*'] }), defaultConfig(['https://y.example.com/*']))
    expect(r.config.matches).toEqual(['https://x.example.com/*'])
    // 未声明的键仍沿用 fallback
    expect(r.config.runAt).toBe('document_end')
    expect(r.config.allFrames).toBe(true)
  })

  it('@noframes 关掉 allFrames；没有它则沿用 fallback', () => {
    expect(applyMetadataToConfig(mk({ noframes: true }), defaultConfig([])).config.allFrames).toBe(false)
    expect(applyMetadataToConfig(mk({}), { ...defaultConfig([]), allFrames: false }).config.allFrames).toBe(false)
  })

  it('@run-at 映射（连字符与下划线两种写法都认）', () => {
    expect(applyMetadataToConfig(mk({ runAtRaw: 'document-start' }), defaultConfig([])).config.runAt).toBe('document_start')
    expect(applyMetadataToConfig(mk({ runAtRaw: 'document_idle' }), defaultConfig([])).config.runAt).toBe('document_idle')
  })

  it('@run-at 取值不认识时沿用原配置并不猜（写 notes）', () => {
    const r = applyMetadataToConfig(mk({ runAtRaw: 'document-body' }), defaultConfig([]))
    expect(r.config.runAt).toBe('document_end')
    expect(r.notes.join('\n')).toContain('@run-at')
  })

  it('注入期字段（grant / requires / resources / 展示字段）随 metadata 采用', () => {
    const r = applyMetadataToConfig(
      mk({
        grants: ['none'],
        requires: ['https://cdn.example.com/a.js'],
        resources: [{ name: 'jq', url: 'https://cdn.example.com/jq.js' }],
        namespace: 'ns',
        version: '2.0.0',
        description: 'd',
        author: 'a',
        icon: 'https://example.com/i.png',
      }),
      defaultConfig([]),
    )
    expect(r.config.grant).toEqual(['none'])
    expect(r.config.requires).toEqual(['https://cdn.example.com/a.js'])
    expect(r.config.resources).toEqual([{ name: 'jq', url: 'https://cdn.example.com/jq.js' }])
    expect(r.config.namespace).toBe('ns')
    expect(r.config.version).toBe('2.0.0')
    expect(r.config.description).toBe('d')
    expect(r.config.author).toBe('a')
    expect(r.config.icon).toBe('https://example.com/i.png')
  })

  it('@name 回传给调用方（用于覆盖脚本名）', () => {
    expect(applyMetadataToConfig(mk({ name: '新名字' }), defaultConfig([])).name).toBe('新名字')
    expect(applyMetadataToConfig(mk({}), defaultConfig([])).name).toBeUndefined()
  })
})

describe('resolveConfigFromSource', () => {
  it('无 metadata 块时原样返回 fallback、零 notes', () => {
    const fallback = defaultConfig(['https://a.example.com/*'])
    const r = resolveConfigFromSource('console.log(1)', fallback)
    expect(r.config).toBe(fallback)
    expect(r.notes).toEqual([])
    expect(r.name).toBeUndefined()
  })

  it('有 metadata 块时解析并归一化', () => {
    const source = `// ==UserScript==
// @name 直接粘进来的标准脚本
// @match https://example.com/*
// ==/UserScript==
console.log(1)`
    const r = resolveConfigFromSource(source, defaultConfig(['*://*/*']))
    expect(r.name).toBe('直接粘进来的标准脚本')
    expect(r.config.matches).toEqual(['https://example.com/*'])
  })
})

// 分发来源键（@updateURL / @downloadURL / @homepageURL）：油猴生态自带的自声明约定 ——
// 读它就不必由本扩展维护任何脚本清单。
describe('分发来源键', () => {
  it('三个键都解析出来（键名大小写不敏感）', () => {
    const m = parseUserScriptMetadata(
      [
        '// ==UserScript==',
        '// @name 来源脚本',
        '// @updateURL https://example.com/x.meta.js',
        '// @downloadURL https://example.com/x.user.js',
        '// @homepageURL https://example.com/x',
        '// ==/UserScript==',
      ].join('\n'),
    )!
    expect(m.updateUrl).toBe('https://example.com/x.meta.js')
    expect(m.downloadUrl).toBe('https://example.com/x.user.js')
    expect(m.homepageUrl).toBe('https://example.com/x')
  })

  it('@homepage 与 @homepageURL 归一：同一个键，先出现的胜（不互相覆盖）', () => {
    const m = parseUserScriptMetadata(
      [
        '// ==UserScript==',
        '// @name 来源脚本',
        '// @homepage https://first.example.com/',
        '// @homepageURL https://second.example.com/',
        '// ==/UserScript==',
      ].join('\n'),
    )!
    expect(m.homepageUrl).toBe('https://first.example.com/')
  })

  it('归一进 config；未声明时沿用 fallback（源码块被重贴不该丢掉来源）', () => {
    const source = `// ==UserScript==
// @name 来源脚本
// @match https://example.com/*
// ==/UserScript==
console.log(1)`
    const fallback = { ...defaultConfig(['*://*/*']), homepageUrl: 'https://kept.example.com/' }
    const r = resolveConfigFromSource(source, fallback)
    expect(r.config.homepageUrl).toBe('https://kept.example.com/')
    // 未声明的另外两个不该凭空长出 undefined 键（undefined 值会被原样带进库里）
    expect('updateUrl' in r.config).toBe(false)
  })
})
