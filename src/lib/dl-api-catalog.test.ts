// DL API 目录（lib/dl-api-catalog.ts）的**防漂移**测试。
//
// catalog 是工作台「DL API」面板的唯一数据来源，而真身是 engine.ts 里那段注入脚本世界的
// `var DL = { ... }` 源码字符串（DL.page 两法在 page-client.ts）。两处一旦分叉，面板就在
// 对着用户说谎（还看不出错），故这里从**源码反射**出真实装配的键集合，与目录双向比对。
//
// 另一道防线在类型层：catalog 的键必须恰好覆盖 DuoLingApi 的全部可调用路径
// （`satisfies Record<DlApiPath, ...>`），契约增删方法而目录没跟上 → typecheck 红。
// 两条都不靠人工对照。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DL_API_ENTRIES, DL_API_GROUPS } from './dl-api-catalog'

const ENGINE_SRC = readFileSync(new URL('./userscripts/engine.ts', import.meta.url), 'utf8')
const PAGE_CLIENT_SRC = readFileSync(new URL('./userscripts/page-client.ts', import.meta.url), 'utf8')

/**
 * 从 `var DL = { ... }` 装配块反射出真实挂到 window.DL 上的路径集合（`store.get` 这种点号形式）。
 *
 * 依赖 engine.ts 里那段代码的缩进（顶层 4 空格、嵌套 6 空格）——它是手写的固定格式，
 * 若哪天被格式化工具重排，这里会拿不到键（集合为空）而红，改回固定缩进即可。
 */
function reflectDlPaths(): string[] {
  const start = ENGINE_SRC.indexOf('var DL = {')
  const end = ENGINE_SRC.indexOf('window.DL = DL')
  if (start < 0 || end < 0) throw new Error('engine.ts 里找不到 DL 装配块（var DL = { … window.DL = DL）')
  const paths: string[] = []
  let current = ''
  for (const line of ENGINE_SRC.slice(start, end).split('\n')) {
    const top = /^ {4}(\w+):/.exec(line)
    if (top) {
      current = top[1]
      // `store: {` 是对象块（其方法在后续 6 空格行），其余为叶子（function / Object.freeze）。
      // page 是例外：它指向 __dlPageApi 变量（不是 `{` 块），方法在 page-client.ts 里另取
      if (current === 'page') continue
      if (!/^ {4}\w+: \{$/.test(line)) paths.push(current)
      continue
    }
    const nested = /^ {6}(\w+): function/.exec(line)
    if (nested && current) paths.push(`${current}.${nested[1]}`)
  }
  return paths
}

/** DL.page 的两个方法在 page-client.ts 里（clientSource 的 return 块，缩进 4 空格） */
function reflectPagePaths(): string[] {
  const tail = PAGE_CLIENT_SRC.slice(PAGE_CLIENT_SRC.indexOf('return {'))
  return [...tail.matchAll(/^ {4}(\w+): function/gm)].map((m) => `page.${m[1]}`)
}

describe('dl-api-catalog 与真实注入的 DL 一致', () => {
  it('路径集合一致（目录没多写、没漏写）', () => {
    const runtime = [...reflectDlPaths(), ...reflectPagePaths()].sort()
    const catalog = DL_API_ENTRIES.map((e) => e.path).sort()
    expect(runtime.length).toBeGreaterThan(20)
    expect(catalog).toEqual(runtime)
  })

  it('每条都有签名 / 说明 / 返回说明，且 signature 带自己的方法名', () => {
    for (const e of DL_API_ENTRIES) {
      expect(e.title, e.path).toBeTruthy()
      expect(e.summary, e.path).toBeTruthy()
      expect(e.detail, e.path).toBeTruthy()
      expect(e.returns, e.path).toBeTruthy()
      const last = e.path.split('.').pop() as string
      expect(e.signature, e.path).toContain(last)
    }
  })

  it('分组都是已声明的组，且每组都非空', () => {
    const ids = DL_API_GROUPS.map((g) => g.id)
    for (const e of DL_API_ENTRIES) expect(ids).toContain(e.group)
    for (const g of DL_API_GROUPS) {
      expect(DL_API_ENTRIES.filter((e) => e.group === g.id).length, `分组 ${g.id} 为空`).toBeGreaterThan(0)
    }
  })
})
