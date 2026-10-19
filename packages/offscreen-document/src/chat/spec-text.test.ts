// 规范文本（spec-text.ts）的**防漂移**测试 —— 三道防线的第三道（管「规范文案 ↔ 目录 / grant 名单」）。
// 防线全貌与存在理由见 docs/adr/0007-spec-three-drift-guards.md。
import { describe, expect, it } from 'vitest'
import { gmApiEntries, specEntries, ALWAYS_WINDOW_MEMBERS, grantNames } from '@duoling/shared'
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
    ...grantNames().filter((n) => n.startsWith('window.')),
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
const ALL_PATHS = gmApiEntries().map((e) => e.path)
/** 规范应逐条列出的成员（每能力一条，不含镜像） */
const LISTED_PATHS = specEntries().map((e) => e.path)

describe('规范文本与能力目录一致', () => {
  it('文本里点到的成员都在能力目录里（除了明确登记的「不支持」例外）', () => {
    const stray = [...MENTIONED].filter(
      (name) =>
        !ALL_PATHS.some((p) => p === name || p.startsWith(`${name}.`)) &&
        !KNOWN_UNSUPPORTED.includes(name),
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
    const bad = declared.filter(
      (n) => !grantNames().includes(n) && !GRANT_SPECIAL_VALUES.includes(n),
    )
    expect(bad, '规范教了一个本扩展不认识的 @grant 名（会被静默忽略）').toEqual([])
  })

  it('合法名字在文本里列全（清单由数据生成，别改成手写还漏几个）', () => {
    const missing = grantNames().filter((n) => !SCRIPT_SPEC_TEXT.includes(`\`${n}\``))
    expect(missing).toEqual([])
  })
})
