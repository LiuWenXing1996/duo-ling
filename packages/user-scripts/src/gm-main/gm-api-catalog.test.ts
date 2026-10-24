import { describe, expect, it } from 'vitest'
import { GM_API_GROUPS, gmApiEntries, grantNames } from '@duoling/shared'
import { GM_MAIN_SRC } from './gm-main.gen'

const WRAPPER_SRC = GM_MAIN_SRC

const ASSEMBLY_MARK = 'var GM_info'

function assembly(): string {
  const i = WRAPPER_SRC.indexOf(ASSEMBLY_MARK)
  if (i < 0) throw new Error(`gm-main 产物里找不到装配块锚点：${ASSEMBLY_MARK}`)
  return WRAPPER_SRC.slice(i)
}

function reflectGlobals(): string[] {
  const out = new Set<string>()
  for (const m of assembly().matchAll(
    /(?:^|\n)\s*(?:if \(GM_HAS\.\w+\) )?(GM_(?!VALUES)[A-Za-z]+)\s*=/g,
  )) {
    out.add(m[1]!)
  }
  return [...out].sort()
}

function reflectNs(): string[] {
  const out = new Set<string>()
  for (const m of assembly().matchAll(/(?:^|\n)\s*(?:if \(GM_HAS\.\w+\) )?GM\.(\w+)\s*=/g))
    out.add(m[1]!)
  return [...out].sort()
}

const OBJECT_BLOCKS: Array<[mark: string, prefix: string]> = [
  ['var __gmCookie = {', 'GM_cookie'],
  ['var __gmAudioApi = {', 'GM_audio'],
]

function reflectObjectMethods(): string[] {
  const assemblyAt = WRAPPER_SRC.indexOf(ASSEMBLY_MARK)
  if (assemblyAt < 0) throw new Error(`gm-main 产物里找不到装配块锚点：${ASSEMBLY_MARK}`)
  const blocks = OBJECT_BLOCKS.map(([mark, prefix]) => {
    const i = WRAPPER_SRC.indexOf(mark)
    if (i < 0) throw new Error(`gm-main 产物里找不到对象定义块：${mark}`)
    return { i, prefix }
  }).sort((a, b) => a.i - b.i)

  const out: string[] = []
  for (let k = 0; k < blocks.length; k++) {
    const from = blocks[k]!.i
    const to = k + 1 < blocks.length ? blocks[k + 1]!.i : assemblyAt
    const block = WRAPPER_SRC.slice(from, to)
    out.push(
      ...[...block.matchAll(/^\s{2}(\w+): function/gm)].map((m) => `${blocks[k]!.prefix}.${m[1]!}`),
    )
  }
  return out.sort()
}

describe('gm-api-catalog 与真实注入的 GM 面一致', () => {
  it('路径集合一致（目录没多写、没漏写）', () => {
    const runtime = [
      ...reflectGlobals(),
      ...reflectNs().map((n) => `GM.${n}`),
      ...reflectObjectMethods(),
      'unsafeWindow',
      'window.onurlchange',
      'window.close',
      'window.focus',
    ].sort()
    const catalog = gmApiEntries()
      .map((e) => e.path)
      .sort()
    expect(runtime.length).toBeGreaterThan(40)
    expect(catalog).toEqual(runtime)
  })

  it('不在赋值反射里的成员确实被挂载（局部声明 / defineProperty 两条路径）', () => {
    expect(WRAPPER_SRC).toContain('var unsafeWindow = window')
    expect(WRAPPER_SRC).toContain('Object.defineProperty(window, "onurlchange"')
    expect(WRAPPER_SRC).toContain('Object.defineProperty(window, "close"')
    expect(WRAPPER_SRC).toContain('Object.defineProperty(window, "focus"')
  })

  it('每条都有签名 / 说明 / 返回说明，且 signature 能认出自己', () => {
    for (const e of gmApiEntries()) {
      expect(e.title, e.path).toBeTruthy()
      expect(e.summary, e.path).toBeTruthy()
      expect(e.detail, e.path).toBeTruthy()
      expect(e.returns, e.path).toBeTruthy()
      expect(e.signature, e.path).toBeTruthy()
      const last = e.path.split('.').pop() as string
      expect(e.signature.toLowerCase(), e.path).toContain(last.toLowerCase())
    }
  })

  it('分组都是已声明的组，且每组都非空', () => {
    const ids = GM_API_GROUPS.map((g) => g.id)
    for (const e of gmApiEntries()) expect(ids).toContain(e.group)
    for (const g of GM_API_GROUPS) {
      expect(
        gmApiEntries().filter((e) => e.group === g.id).length,
        `分组 ${g.id} 为空`,
      ).toBeGreaterThan(0)
    }
  })

  it('同一能力的两形态成对出现（全局 + GM.*），路径不重复', () => {
    const paths = gmApiEntries().map((e) => e.path)
    expect(new Set(paths).size).toBe(paths.length)
    const globals = paths.filter((p) => p.startsWith('GM_') && !p.includes('.'))
    const ns = paths.filter((p) => p.startsWith('GM.'))
    expect(ns.length).toBeGreaterThan(0)
    expect(globals.length).toBeGreaterThan(ns.length - 3)
  })

  it('说明里提到的 `@grant` 名都是本扩展认得的（认不得的名字会被静默忽略，等于白写）', () => {
    for (const e of gmApiEntries()) {
      for (const m of e.detail.matchAll(/@grant\s+([A-Za-z_][\w.]*)/g)) {
        expect(grantNames(), `${e.path} 的说明教了一个不认识的 @grant 名：${m[1]}`).toContain(m[1])
      }
    }
  })
})
