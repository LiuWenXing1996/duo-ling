// GM API 目录（lib/gm-api-catalog.ts）的**防漂移**测试。
//
// 目录是工作台「GM API」面板的唯一数据来源，而真身是 gm-wrapper.ts 里那段注入源码的**装配块**
// （GM.page 的两个方法在 gm-wrapper.ts 的 `__gmPageApi` 块）。两处一旦分叉，面板就在对着用户说谎（还看不出错），
// 故这里从源码反射出真实挂载的键集合，与目录双向比对。
//
// 另一道防线在类型层：能力表的键必须恰好覆盖 `keyof GmGlobalFns`
// （`satisfies Record<GmGlobalName, Capability>`），契约增删方法而目录没跟上 → typecheck 红。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GM_API_ENTRIES, GM_API_GROUPS } from './gm-api-catalog'
import { GRANT_NAMES } from './gm-grants'

const WRAPPER_SRC = readFileSync(new URL('./userscripts/gm-wrapper.ts', import.meta.url), 'utf8')

/** 装配块的起点注释；找不到即说明包装被重构过，反射锚点需同步更新（会让测试红，不会静默） */
const ASSEMBLY_MARK = '// —— 组装成员（按 @grant 裁剪'

function assembly(): string {
  const i = WRAPPER_SRC.indexOf(ASSEMBLY_MARK)
  if (i < 0) throw new Error(`gm-wrapper.ts 里找不到装配块锚点：${ASSEMBLY_MARK}`)
  return WRAPPER_SRC.slice(i)
}

/**
 * 全局函数 / 全局对象：`if (GM_HAS.X) GM_x = …`。
 * 注意是**局部声明**而非 `window.GM_x = …` —— MAIN 世界下同帧多脚本共享一个 window，
 * 挂上去会互相覆盖，故全部改成函数作用域内的变量（见 gm-wrapper.ts 文件头）。
 * `GM_VALUES` 要挡掉：那是值快照的赋值，不是成员。
 */
function reflectGlobals(): string[] {
  const out = new Set<string>()
  for (const m of assembly().matchAll(/(?:^|\n)\s*(?:if \(GM_HAS\.\w+\) )?(GM_(?!VALUES)[A-Za-z]+)\s*=/g)) {
    out.add(m[1]!)
  }
  return [...out].sort()
}

/** `GM.*` 成员：`if (GM_HAS.x) GM.x = …` 与无条件的 `GM.y = …` */
function reflectNs(): string[] {
  const out = new Set<string>()
  for (const m of assembly().matchAll(/(?:^|\n)\s*(?:if \(GM_HAS\.\w+\) )?GM\.(\w+)\s*=/g)) out.add(m[1]!)
  return [...out].sort()
}

/** `GM_cookie` 的方法（对象成员，类型层取不到，从 `__gmCookie` 定义块反射） */
function reflectCookieMethods(): string[] {
  const i = WRAPPER_SRC.indexOf('var __gmCookie = {')
  const j = WRAPPER_SRC.indexOf(ASSEMBLY_MARK)
  if (i < 0 || j < i) throw new Error('gm-wrapper.ts 里找不到 __gmCookie 定义块')
  const block = WRAPPER_SRC.slice(i, j)
  return [...block.matchAll(/^\s{4}(\w+): function/gm)].map((m) => `GM_cookie.${m[1]!}`).sort()
}

/** `GM.page` 的两个方法：包装里的 `__gmPageApi` 定义块（缩进 4 空格） */
function reflectPagePaths(): string[] {
  const i = WRAPPER_SRC.indexOf('var __gmPageApi = {')
  if (i < 0) throw new Error('gm-wrapper.ts 里找不到 __gmPageApi 定义块')
  const end = WRAPPER_SRC.indexOf('\n  }\n', i)
  const block = WRAPPER_SRC.slice(i, end < 0 ? undefined : end)
  return [...block.matchAll(/^ {4}(\w+):/gm)].map((m) => `GM.page.${m[1]!}`).sort()
}

describe('gm-api-catalog 与真实注入的 GM 面一致', () => {
  it('路径集合一致（目录没多写、没漏写）', () => {
    const nsNames = reflectNs()
    // `GM.page` 这个容器本身不单独成条目：它展开成 GM.page.listen / fetchHook 两条
    expect(nsNames, '包装里已不再挂载 GM.page').toContain('page')
    const runtime = [
      ...reflectGlobals(),
      ...nsNames.filter((n) => n !== 'page').map((n) => `GM.${n}`),
      ...reflectCookieMethods(),
      ...reflectPagePaths(),
      'unsafeWindow',
      'window.onurlchange',
    ].sort()
    const catalog = GM_API_ENTRIES.map((e) => e.path).sort()
    expect(runtime.length).toBeGreaterThan(40)
    expect(catalog).toEqual(runtime)
  })

  it('两条**不在赋值反射里**的成员确实被挂载（unsafeWindow 走局部声明，onurlchange 走 defineProperty）', () => {
    // 反向断言：unsafeWindow 走局部声明（MAIN 世界下它就是 window），不是挂到 window 上的属性
    expect(WRAPPER_SRC).toContain('var unsafeWindow = window')
    expect(WRAPPER_SRC).toContain("Object.defineProperty(window, 'onurlchange'")
  })

  it('每条都有签名 / 说明 / 返回说明，且 signature 能认出自己', () => {
    for (const e of GM_API_ENTRIES) {
      expect(e.title, e.path).toBeTruthy()
      expect(e.summary, e.path).toBeTruthy()
      expect(e.detail, e.path).toBeTruthy()
      expect(e.returns, e.path).toBeTruthy()
      expect(e.signature, e.path).toBeTruthy()
      // 签名里应出现该路径的「末段名」（`GM_cookie.list` → `list`；`window.onurlchange` → `onurlchange`）
      const last = e.path.split('.').pop() as string
      expect(e.signature.toLowerCase(), e.path).toContain(last.toLowerCase())
    }
  })

  it('分组都是已声明的组，且每组都非空', () => {
    const ids = GM_API_GROUPS.map((g) => g.id)
    for (const e of GM_API_ENTRIES) expect(ids).toContain(e.group)
    for (const g of GM_API_GROUPS) {
      expect(GM_API_ENTRIES.filter((e) => e.group === g.id).length, `分组 ${g.id} 为空`).toBeGreaterThan(0)
    }
  })

  it('同一能力的两形态成对出现（全局 + GM.*），路径不重复', () => {
    const paths = GM_API_ENTRIES.map((e) => e.path)
    expect(new Set(paths).size).toBe(paths.length)
    const globals = paths.filter((p) => p.startsWith('GM_') && !p.includes('.'))
    const ns = paths.filter((p) => p.startsWith('GM.') && !p.startsWith('GM.page.'))
    expect(ns.length).toBeGreaterThan(0)
    expect(globals.length).toBeGreaterThan(ns.length - 3)
  })

  it('说明里提到的 `@grant` 名都是本扩展认得的（认不得的名字会被静默忽略，等于白写）', () => {
    for (const e of GM_API_ENTRIES) {
      for (const m of e.detail.matchAll(/@grant\s+([A-Za-z_][\w.]*)/g)) {
        expect(GRANT_NAMES, `${e.path} 的说明教了一个不认识的 @grant 名：${m[1]}`).toContain(m[1])
      }
    }
  })
})
