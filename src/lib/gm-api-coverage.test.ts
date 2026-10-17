// 「GM 全能探针」用例 ↔ 目录（gm-api-catalog）的**覆盖对齐**测试。
//
// 目录是「有哪些 GM API」的唯一清单源；探针（packages/uscript-samples 的 omni-probe）是
// **真机那一层**的唯一验收入口。两边一分叉就会出现「目录里新加了 API，但没人手测过它」——
// 这正是已定位的缺口。故探针带一张覆盖登记表（covers.ts，结构化导出）：
//
//     { probe: '<用例名>', paths: ['<目录路径>…'] }
//
// 本测试核对四件事：登记表里的路径恰好覆盖目录、用例名在探针里真实存在（防标签指向幽灵用例）、
// 路径没多没少、单行不超 4 条（超了报错时定位不到是哪个 API）。
//
// 两个反射锚点的取材面：
//   · 登记表 —— 直接 import covers.ts（类型化数据，登记表与测试不再隔一层注释解析）；
//   · 用例名 —— 正则扫 cases/*.ts 源码里 `add('<组>', '<名>'` 的第二参（登记表 probe 字段
//     须与它一字不差；用例只在构建产物里跑，源码反射是唯一的对齐面）。
// 另对**构建产物**做 acorn 语法检查 —— 端测注入与手测导入的都是它，语法错一次就静默全废。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'acorn'
import { describe, expect, it } from 'vitest'
import { gmApiEntries } from '@duoling/shared'
import { COVERS } from '../../packages/uscript-samples/src/omni-probe/covers'

/** 探针构建产物（test 脚本先 `pnpm -r build`；单跑 vitest 前需先 build 一次） */
const PROBE_DIST_URL = new URL('../../packages/uscript-samples/dist/omni-probe/omni-probe.user.js', import.meta.url)
function probeDist(): string {
  if (!existsSync(PROBE_DIST_URL)) {
    throw new Error('探针产物不存在：先跑 pnpm -r build 生成 packages/uscript-samples/dist/')
  }
  return readFileSync(PROBE_DIST_URL, 'utf8')
}

/** 用例源码目录（登记表 probe 字段的对齐面） */
const CASES_DIR = fileURLToPath(new URL('../../packages/uscript-samples/src/omni-probe/cases/', import.meta.url))

/** 目录路径（收窄成 string：登记表那侧是自由文本，两边才好比） */
const CATALOG: string[] = gmApiEntries().map((e) => e.path).sort()
/** 登记表里出现过的全部路径 */
const DECLARED_PATHS = [...new Set(COVERS.flatMap((d) => d.paths))].sort()

/** 探针里真实登记的用例名（cases/*.ts 里 `add('<组>', '<名>'` 的第二参） */
function caseNames(): string[] {
  const names: string[] = []
  for (const f of readdirSync(CASES_DIR).sort()) {
    if (!f.endsWith('.ts')) continue
    const src = readFileSync(CASES_DIR + f, 'utf8')
    for (const m of src.matchAll(/^[ \t]*add\('[^']*',[\t ]*'([^']+)'/gm)) names.push(m[1]!)
  }
  return names
}

describe('GM 全能探针覆盖目录', () => {
  it('探针构建产物语法合法（acorn 解析；它是手测与端测共用的真身，语法错一次就静默全废）', () => {
    expect(() => parse(probeDist(), { ecmaVersion: 'latest' })).not.toThrow()
  })

  it('登记表格式合法（每条都写了 `用例名 :: 路径`，且路径不超 4 条）', () => {
    const rows = COVERS
    expect(rows.length, '覆盖登记表是空的').toBeGreaterThan(20)
    for (const row of rows) {
      // 允许「无路径」的登记（paths: []）：有些用例验的不是某个 API ——
      // 例如注入时机（run-at document-body），它们只需要证明「这条用例存在且已登记」，
      // 不认领目录里的任何路径。有路径时仍限制条数，好让报错能定位到是哪个 API。
      expect(row.paths.length, `一条用例认领太多路径（报错定位不到是哪个 API）：${row.probe}`).toBeLessThanOrEqual(4)
    }
  })

  it('登记表真的取到了路径（防锚点失效后「两边都空」的假绿）', () => {
    expect(DECLARED_PATHS.length).toBeGreaterThan(30)
    expect(DECLARED_PATHS).toContain('GM_info')
    expect(DECLARED_PATHS).toContain('GM.setValue')
  })

  it('用例与登记表一一对应（每个用例都被认领、每条登记都有用例）', () => {
    const cases = caseNames()
    expect(cases.length, '反射到的用例太少，锚点可能失效').toBeGreaterThan(20)
    const claimed = COVERS.map((d) => d.probe)
    expect(claimed.filter((n) => !cases.includes(n)), '登记表里的用例名在探针里不存在（幽灵条目）').toEqual([])
    expect(cases.filter((n) => !claimed.includes(n)), '探针里有没进登记表的用例（漏登记）').toEqual([])
  })

  it('目录里的每条路径都被认领（探针不留空行）', () => {
    const uncovered = CATALOG.filter((p) => !DECLARED_PATHS.includes(p))
    expect(uncovered, `目录里有、探针没覆盖的路径：${uncovered.join(', ')}`).toEqual([])
  })

  it('登记表里的路径都还在目录里（防留下已下架的路径）', () => {
    const stale = DECLARED_PATHS.filter((p) => !CATALOG.includes(p))
    expect(stale, `登记表里有、目录里已没有的路径：${stale.join(', ')}`).toEqual([])
  })
})
