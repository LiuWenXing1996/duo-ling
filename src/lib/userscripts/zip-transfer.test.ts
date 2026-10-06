// zip-transfer.ts 单测：编解码纯函数（zip 格式、后缀识别、字段兜底、目录去重、指纹）。
// 解码侧扫全包：路径以 .user.js 结尾即源码（任意层级、同目录多份都收），其余文件进未导入报告；
// 配置由源码里的 // ==UserScript== 块派生（导入侧解析）。node 环境直跑（本模块零 chrome API）。
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  ZIP_SCHEMA_VERSION,
  base64ToBytes,
  buildScriptZip,
  bytesToBase64,
  parseScriptsZip,
  sanitizeDirName,
  sourceFingerprint,
} from './zip-transfer'

/** 用字符串 entries 打一个 zip（测试辅助） */
function makeZip(entries: Record<string, string>): Uint8Array {
  const u8: Record<string, Uint8Array> = {}
  for (const [k, v] of Object.entries(entries)) u8[k] = strToU8(v)
  return zipSync(u8)
}

/** 构造带 // ==UserScript== 块的源码（name / matches 派生配置） */
function withMeta(name: string, code = 'console.log(1)', matches: string[] = []): string {
  const lines = ['// ==UserScript==', `// @name ${name}`]
  for (const m of matches) lines.push(`// @match ${m}`)
  lines.push('// ==/UserScript==')
  return lines.join('\n') + '\n' + code
}

describe('buildScriptZip + parseScriptsZip 往返', () => {
  it('单脚本往返：name 取 @name、config 由 metadata 派生、code 原样保真', () => {
    const code = withMeta('示例脚本', 'console.log(1)', ['https://example.com/*'])
    const zip = buildScriptZip([{ name: '示例脚本', code }])
    const { scripts, ignored } = parseScriptsZip(zip)
    expect(ignored).toEqual([])
    expect(scripts).toHaveLength(1)
    expect(scripts[0].name).toBe('示例脚本')
    expect(scripts[0].config.matches).toEqual(['https://example.com/*'])
    expect(scripts[0].config.allFrames).toBe(true)
    expect(scripts[0].config.runAt).toBe('document_idle')
    expect(scripts[0].code).toBe(code)
  })

  it('buildScriptZip 只打包 <脚本名>.user.js（配置不进 zip，由导入侧从源码派生）', () => {
    const zip = buildScriptZip([{ name: 'A', code: 'x' }])
    const files = unzipSync(zip)
    expect(Object.keys(files).sort()).toEqual(['A/A.user.js'])
    expect(strFromU8(files['A/A.user.js']!)).toBe('x')
  })

  it('脚本名本身带 .user.js 后缀时不叠加（foo.user.js → foo/foo.user.js）', () => {
    const files = unzipSync(buildScriptZip([{ name: 'foo.user.js', code: 'x' }]))
    expect(Object.keys(files)).toEqual(['foo/foo.user.js'])
  })

  it('多脚本同名（@name 相同）：目录加 -2 后缀去重，@name 各自保真（目录名 ≠ 真名）', () => {
    const zip = buildScriptZip([
      { name: '同名', code: withMeta('同名', '// 1') },
      { name: '同名', code: withMeta('同名', '// 2') },
    ])
    expect(
      Object.keys(unzipSync(zip))
        .filter((k) => k.endsWith('.user.js'))
        .sort(),
    ).toEqual(['同名-2/同名.user.js', '同名/同名.user.js'])
    const { scripts, ignored } = parseScriptsZip(zip)
    expect(ignored).toEqual([])
    // 目录名去重为 同名 / 同名-2，但导入名取 @name（=真名），不被目录名干扰
    expect(scripts.map((s) => s.name)).toEqual(['同名', '同名'])
    expect(scripts.map((s) => s.code)).toEqual([withMeta('同名', '// 1'), withMeta('同名', '// 2')])
  })

  it('目录名做 Windows 保留字符安全化', () => {
    expect(sanitizeDirName('a/b:c*d?"<>|')).toBe('a_b_c_d_____')
    expect(sanitizeDirName('  结尾点.  ')).toBe('结尾点')
    expect(sanitizeDirName('///')).toBe('___') // 全部是保留字符：替换后仍可作为目录名
    expect(sanitizeDirName('  ')).toBe('script') // 全空白才兜底
    expect(sanitizeDirName('x'.repeat(100))).toHaveLength(64)
  })

  it('ZIP_SCHEMA_VERSION 保留为历史字段（=2），解码侧不据此拦截', () => {
    expect(ZIP_SCHEMA_VERSION).toBe(2)
  })
})

describe('parseScriptsZip 解析（扫全包：后缀 .user.js 即源码）', () => {
  it('任意源码内容都能导入（无版本 / manifest 概念，配置全由源码派生）', () => {
    const { scripts, ignored } = parseScriptsZip(makeZip({ 'a/a.user.js': '随便什么内容' }))
    expect(ignored).toEqual([])
    expect(scripts).toHaveLength(1)
    expect(scripts[0].config.matches).toEqual([]) // 无 metadata 块 → 默认空 matches
  })

  it('摊在 zip 根也能导入：不要求放进目录', () => {
    const { scripts, ignored } = parseScriptsZip(
      makeZip({ 'a.user.js': withMeta('A'), 'b.user.js': withMeta('B') }),
    )
    expect(scripts.map((s) => s.name)).toEqual(['A', 'B'])
    expect(ignored).toEqual([])
  })

  it('同一个目录里多份 .user.js → 全部导入（各成一条记录，不算歧义）', () => {
    const { scripts, ignored } = parseScriptsZip(
      makeZip({ 'demo/a.user.js': withMeta('A'), 'demo/b.user.js': withMeta('B') }),
    )
    expect(scripts.map((s) => s.name)).toEqual(['A', 'B'])
    expect(ignored).toEqual([])
  })

  it('任意层级都收：子目录里的 .user.js 也算源码', () => {
    const { scripts } = parseScriptsZip(makeZip({ 'a/sub/deep.user.js': withMeta('深层') }))
    expect(scripts.map((s) => s.name)).toEqual(['深层'])
  })

  it('后缀比较忽略大小写（.User.JS 也认）', () => {
    const { scripts, ignored } = parseScriptsZip(makeZip({ 'x/My.User.JS': 'x' }))
    expect(scripts).toHaveLength(1)
    expect(ignored).toEqual([])
  })

  it('无 metadata 块：name 取文件名（去后缀）、config 用默认（matches 空）、notes 提示补全（不阻断）', () => {
    const { scripts } = parseScriptsZip(makeZip({ 'my-dir/my-script.user.js': 'x' }))
    expect(scripts).toHaveLength(1)
    // name ← 文件名（不是目录名）；matches ← 空（留给编辑器补）
    expect(scripts[0]).toMatchObject({ name: 'my-script' })
    expect(scripts[0].config.matches).toEqual([])
    const notes = (scripts[0].notes ?? []).join(' ')
    expect(notes).toContain('文件名')
    expect(notes).toContain('matches')
  })

  it('文件名剥空（.user.js 前没有名字）时兜底为 script', () => {
    const { scripts } = parseScriptsZip(makeZip({ 'a/.user.js': 'x' }))
    expect(scripts[0]!.name).toBe('script')
  })

  it('metadata 块声明字段：matches 保留，未声明字段用默认（allFrames/runAt）', () => {
    const code = withMeta('a', 'console.log(1)', ['*://a.com/*'])
    const { scripts } = parseScriptsZip(makeZip({ 'x/x.user.js': code }))
    expect(scripts[0].config).toEqual({ matches: ['*://a.com/*'], allFrames: true, runAt: 'document_idle' })
    expect(scripts[0].notes).toBeUndefined() // 合法 metadata，无 notes
  })

  it('非 .user.js 条目（老式 script.js / data/ 杂项 / 散文件）未导入并逐条汇进 ignored 报告', () => {
    const zip = makeZip({
      '脚本.user.js': 'console.log(1)',
      'data/whatever.json': '{}',
      '旧包/script.js': '// 名字不对的老式包',
      'loose.txt': '顶层散文件',
    })
    const { scripts, ignored } = parseScriptsZip(zip)
    expect(scripts).toHaveLength(1)
    expect(scripts[0].code).toBe('console.log(1)')
    expect(ignored.map((i) => i.path).sort()).toEqual([
      'data/whatever.json',
      'loose.txt',
      '旧包/script.js',
    ])
    expect(ignored.every((i) => i.reason.includes('.user.js'))).toBe(true)
  })

  it('目录占位条目（path 以 / 结尾）不计入 ignored（只是机械目录项，报出来是噪声）', () => {
    const zip = makeZip({
      '示例脚本/示例脚本.user.js': 'console.log(1)',
      '示例脚本/': '', // 机械目录占位
      'loose.txt': 'x', // 这条才是文件
    })
    const { scripts, ignored } = parseScriptsZip(zip)
    expect(scripts).toHaveLength(1)
    expect(ignored.map((i) => i.path)).toEqual(['loose.txt'])
  })

  it('可导入者与 ignored 互不牵连：一个包里既有源码又有杂项', () => {
    const zip = makeZip({
      '好的/好的.user.js': withMeta('好的', '// ok'),
      '空源码.user.js': '', // 空源码：能构造记录，照常导入
      '杂项/notes.txt': '// 不是源码',
    })
    const { scripts, ignored } = parseScriptsZip(zip)
    expect(scripts.map((s) => s.name)).toEqual(['好的', '空源码'])
    expect(ignored.map((i) => i.path)).toEqual(['杂项/notes.txt'])
  })
})

describe('base64 传输与内容指纹', () => {
  it('bytesToBase64 / base64ToBytes 往返保真（含非 ASCII 字节）', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 128])
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })

  it('sourceFingerprint：内容相同同指纹，内容不同指纹不同', async () => {
    const a = await sourceFingerprint('console.log(1)')
    const b = await sourceFingerprint('console.log(1)')
    const c = await sourceFingerprint('console.log(2)')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})
