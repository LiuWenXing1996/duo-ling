// 「GM 可用性矩阵」探针 ↔ 目录（gm-api-catalog）的**覆盖对齐**测试。
//
// 目录是「有哪些 GM API」的唯一清单源；矩阵探针（uscript-samples/gm-matrix/script.js）是
// **真机那一层**的唯一验收入口。两边一分叉就会出现「目录里新加了 API，但没人手测过它」——
// 这正是 2026-09-21 定位到的缺口。故探针顶部挂一张覆盖登记表：
//
//     // @covers <用例名> :: <路径…>
//
// 本测试核对四件事：登记表里的路径恰好覆盖目录、用例名在探针里真实存在（防标签指向幽灵用例）、
// 路径没多没少、单行不超 4 条（超了报错时定位不到是哪个 API）。
//
// 探针是普通 JS（不经构建、不进 src），故只能读源码文本反射——与 gm-api-catalog.test.ts
// 反射 gm-wrapper 装配块同一套做法。
import { readFileSync } from 'node:fs'
import { parse } from 'acorn'
import { describe, expect, it } from 'vitest'
import { GM_API_ENTRIES } from './gm-api-catalog'

const PROBE_SRC = readFileSync(new URL('../../uscript-samples/gm-matrix/script.js', import.meta.url), 'utf8')

interface Declared {
  /** 认领方（探针里的用例名，须一字不差） */
  probe: string
  /** 被认领的目录路径 */
  paths: string[]
}

/** 解析覆盖登记表（`// @covers <用例名> :: <路径…>`） */
function declared(): Declared[] {
  const out: Declared[] = []
  for (const m of PROBE_SRC.matchAll(/^[ \t]*\/\/[ \t]*@covers[ \t]+(.+)$/gm)) {
    const raw = m[1]!.trim()
    const sep = raw.indexOf('::')
    if (sep < 0) {
      out.push({ probe: raw, paths: [] })
      continue
    }
    out.push({ probe: raw.slice(0, sep).trim(), paths: raw.slice(sep + 2).trim().split(/\s+/).filter(Boolean) })
  }
  return out
}

/** 探针里真实登记的用例名（`add('<group>', '<用例名>'` 的第二参） */
function caseNames(): string[] {
  return [...PROBE_SRC.matchAll(/^[ \t]*add\('[^']*',[ \t]*'([^']+)'/gm)].map((m) => m[1]!)
}

/** 目录路径（收窄成 string：登记表那侧是自由文本，两边才好比） */
const CATALOG: string[] = GM_API_ENTRIES.map((e) => e.path).sort()
/** 登记表里出现过的全部路径 */
const DECLARED_PATHS = [...new Set(declared().flatMap((d) => d.paths))].sort()

describe('GM 可用性矩阵探针覆盖目录', () => {
  it('探针源码语法合法（acorn 解析；它是手测脚本，语法错一次就静默全废）', () => {
    expect(() => parse(PROBE_SRC, { ecmaVersion: 'latest' })).not.toThrow()
  })

  it('登记表格式合法（每条都写了 `用例名 :: 路径`，且路径不超 4 条）', () => {
    const rows = declared()
    expect(rows.length, '探针里没找到 @covers 登记表').toBeGreaterThan(20)
    for (const row of rows) {
      // 允许「无路径」的登记（`// @covers <用例名>`，没有 `::`）：有些用例验的不是某个 API ——
      // 例如注入时机（run-at document-body），它们只需要证明「这条用例存在且已登记」，
      // 不认领目录里的任何路径。有路径时仍限制条数，好让报错能定位到是哪个 API。
      expect(row.paths.length, `一条用例认领太多路径（报错定位不到是哪个 API）：${row.probe}`).toBeLessThanOrEqual(4)
    }
  })

  it('反射真的取到了路径（防锚点失效后「两边都空」的假绿）', () => {
    expect(DECLARED_PATHS.length).toBeGreaterThan(30)
    expect(DECLARED_PATHS).toContain('GM_info')
    expect(DECLARED_PATHS).toContain('GM.page.fetchHook')
  })

  it('用例与登记表一一对应（每个用例都被认领、每条登记都有用例）', () => {
    const cases = caseNames()
    expect(cases.length, '反射到的用例太少，锚点可能失效').toBeGreaterThan(20)
    const claimed = declared().map((d) => d.probe)
    expect(claimed.filter((n) => !cases.includes(n)), '登记表里的用例名在探针里不存在（幽灵条目）').toEqual([])
    expect(cases.filter((n) => !claimed.includes(n)), '探针里有没进登记表的用例（漏登记）').toEqual([])
  })

  it('目录里的每条路径都被认领（矩阵不留空行）', () => {
    const uncovered = CATALOG.filter((p) => !DECLARED_PATHS.includes(p))
    expect(uncovered, `目录里有、矩阵探针没覆盖的路径：${uncovered.join(', ')}`).toEqual([])
  })

  it('登记表里的路径都还在目录里（防留下已下架的路径）', () => {
    const stale = DECLARED_PATHS.filter((p) => !CATALOG.includes(p))
    expect(stale, `登记表里有、目录里已没有的路径：${stale.join(', ')}`).toEqual([])
  })
})
