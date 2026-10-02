// 规范文本（offscreen-chat/spec-text.ts）的**防漂移**测试。
//
// 这是第三道防线：前两道在 gm-api-catalog.test.ts（类型层 + 从注入源码反射），管的是「目录 ↔ 真身」；
// 这一道管「**规范文案 ↔ 目录 / grant 名单**」。
//
// 为什么需要：规范是 AI 写脚本时唯一的事实来源。它引用一个不存在的成员、或教 AI 写一个本扩展不认的
// `@grant` 名，都不会有任何运行时报错 —— 只会让模型照着错的东西生成脚本，而用户看到的只是一份跑不通
// 的脚本。能力清单与 `@grant` 一节已由数据生成，这里防的是「有人改回手写」与「手写段引用错名字」。
import { describe, expect, it } from 'vitest'
import { GM_API_ENTRIES, specEntries } from '@/lib/gm-api-catalog'
import { ALWAYS_WINDOW_MEMBERS, GRANT_NAMES } from '@/lib/gm-grants'
import { SCRIPT_SPEC_TEXT } from './spec-text'

/** 规范文本里**故意**点名、但不在能力目录里的成员（目录 = 已实现的成员） */
const KNOWN_UNSUPPORTED: string[] = []

/** `@grant` 的特殊值（不是 API 名） */
const GRANT_SPECIAL_VALUES = ['none']

/**
 * 文本里提到的成员名（只取首段：`GM_info.script` 记 `GM_info`，`GM_cookie.list` 记 `GM_cookie`）。
 * `GM_*` / `GM.*` 这两个通配写法不会被匹配（后面不是字母）。
 */
function mentionedNames(text: string): Set<string> {
  const out = new Set<string>([
    ...[...text.matchAll(/\bGM_[A-Za-z]+/g)].map((m) => m[0]),
    ...[...text.matchAll(/\bGM\.[A-Za-z]+/g)].map((m) => m[0]),
    ...[...text.matchAll(/\bunsafeWindow\b/g)].map((m) => m[0]),
  ])
  // window 级成员：恒注入的（`window.onurlchange`）与 `@grant` 项（`window.close` / `window.focus`）
  // 都是 window 属性路径。名单从 gm-grants 取、逐个查文本，**不用通配正则** ——
  // 否则 `window.addEventListener` 这类无关写法会被当成「引用了某个能力」。
  const windowMembers = [
    ...ALWAYS_WINDOW_MEMBERS,
    ...GRANT_NAMES.filter((n) => n.startsWith('window.')),
  ]
  for (const name of windowMembers) if (text.includes(name)) out.add(name)
  return out
}

/** 目录里的路径有没有被文本提到（允许只提到容器名，如 `GM_cookie` 代表 `GM_cookie.list`） */
function isMentioned(path: string, mentioned: Set<string>): boolean {
  const segs = path.split('.')
  for (let n = segs.length; n > 0; n--) {
    if (mentioned.has(segs.slice(0, n).join('.'))) return true
  }
  return false
}

const MENTIONED = mentionedNames(SCRIPT_SPEC_TEXT)
/** 合法成员全集：面板清单（含 `GM.*` 镜像形态——规范里提到异步形态是合理的） */
const ALL_PATHS = GM_API_ENTRIES.map((e) => e.path)
/** 规范应逐条列出的成员（每能力一条，不含镜像） */
const LISTED_PATHS = specEntries().map((e) => e.path)

describe('规范文本与能力目录一致', () => {
  it('文本里点到的成员都在能力目录里（除了明确登记的「不支持」例外）', () => {
    const stray = [...MENTIONED].filter(
      (name) =>
        !ALL_PATHS.some((p) => p === name || p.startsWith(`${name}.`)) && !KNOWN_UNSUPPORTED.includes(name),
    )
    expect(stray, '规范里引用了能力目录之外的成员——要么是错名字，要么该进目录').toEqual([])
  })

  it('能力目录里每条都在文本里出现过（漏写 = AI 不知道有这能力）', () => {
    const missing = LISTED_PATHS.filter((p) => !isMentioned(p, MENTIONED))
    expect(missing, '这些能力没进规范文本').toEqual([])
  })

  it('「不支持」例外与能力目录不相交（哪天真的实现了，这条例外就该删）', () => {
    for (const name of KNOWN_UNSUPPORTED) expect(ALL_PATHS).not.toContain(name)
  })
})

describe('规范文本与 `@grant` 名单一致', () => {
  it('文本里点到的 `@grant` 名都在合法名单里', () => {
    const declared = [...SCRIPT_SPEC_TEXT.matchAll(/@grant\s+([A-Za-z_][\w.]*)/g)].map((m) => m[1]!)
    const bad = declared.filter((n) => !GRANT_NAMES.includes(n) && !GRANT_SPECIAL_VALUES.includes(n))
    expect(bad, '规范教了一个本扩展不认识的 @grant 名（会被静默忽略）').toEqual([])
  })

  it('合法名字在文本里列全（清单由数据生成，别改成手写还漏几个）', () => {
    const missing = GRANT_NAMES.filter((n) => !SCRIPT_SPEC_TEXT.includes(`\`${n}\``))
    expect(missing).toEqual([])
  })
})
