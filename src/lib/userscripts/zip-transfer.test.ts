// zip-transfer.ts 单测：编解码纯函数（zip 格式、路径过滤、字段兜底、目录去重、指纹）。
// 单文件形态：zip 内只有 script.js，配置由源码里的 // ==UserScript== 块派生（导入侧解析）。
// 解码侧「只拦原则项、尽量导入」。node 环境直跑（本模块零 chrome API）。
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
    const { scripts, skipped } = parseScriptsZip(zip)
    expect(skipped).toEqual([])
    expect(scripts).toHaveLength(1)
    expect(scripts[0].name).toBe('示例脚本')
    expect(scripts[0].config.matches).toEqual(['https://example.com/*'])
    expect(scripts[0].config.allFrames).toBe(true)
    expect(scripts[0].config.runAt).toBe('document_idle')
    expect(scripts[0].code).toBe(code)
  })

  it('buildScriptZip 只打包 script.js（配置不进 zip，由导入侧从源码派生）', () => {
    const zip = buildScriptZip([{ name: 'A', code: 'x' }])
    const files = unzipSync(zip)
    expect(Object.keys(files).sort()).toEqual(['A/script.js'])
    expect(strFromU8(files['A/script.js']!)).toBe('x')
  })

  it('多脚本同名（@name 相同）：目录加 -2 后缀去重，@name 各自保真（目录名 ≠ 真名）', () => {
    const zip = buildScriptZip([
      { name: '同名', code: withMeta('同名', '// 1') },
      { name: '同名', code: withMeta('同名', '// 2') },
    ])
    expect(
      Object.keys(unzipSync(zip))
        .filter((k) => k.endsWith('/script.js'))
        .sort(),
    ).toEqual(['同名-2/script.js', '同名/script.js'])
    const { scripts, skipped } = parseScriptsZip(zip)
    expect(skipped).toEqual([])
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

describe('parseScriptsZip 解析（尽量导入：只拦原则项，2026-09-20 单文件化）', () => {
  it('任意源码内容都能导入（无版本 / manifest 概念，配置全由源码派生）', () => {
    const { scripts, skipped } = parseScriptsZip(makeZip({ 'a/script.js': '随便什么内容' }))
    expect(skipped).toEqual([])
    expect(scripts).toHaveLength(1)
    expect(scripts[0].config.matches).toEqual([]) // 无 metadata 块 → 默认空 matches
  })

  it('缺 script.js → 跳过（无源码就构造不出记录，唯一原则项）', () => {
    const { scripts, skipped } = parseScriptsZip(makeZip({ '孤儿目录/notes.txt': 'x' }))
    expect(scripts).toEqual([])
    expect(skipped).toEqual([{ dirName: '孤儿目录', reason: expect.stringContaining('script.js') }])
  })

  it('无 metadata 块：name 取目录名、config 用默认（matches 空）、notes 提示补全（不阻断）', () => {
    const { scripts, skipped } = parseScriptsZip(makeZip({ 'my-dir/script.js': 'x' }))
    expect(skipped).toEqual([])
    expect(scripts).toHaveLength(1)
    // name ← 目录名；matches ← 空（留给编辑器补）
    expect(scripts[0]).toMatchObject({ name: 'my-dir' })
    expect(scripts[0].config.matches).toEqual([])
    const notes = (scripts[0].notes ?? []).join(' ')
    expect(notes).toContain('目录名')
    expect(notes).toContain('matches')
  })

  it('metadata 块声明字段：matches 保留，未声明字段用默认（allFrames/runAt）', () => {
    const code = withMeta('a', 'console.log(1)', ['*://a.com/*'])
    const { scripts } = parseScriptsZip(makeZip({ 'x/script.js': code }))
    expect(scripts[0].config).toEqual({ matches: ['*://a.com/*'], allFrames: true, runAt: 'document_idle' })
    expect(scripts[0].notes).toBeUndefined() // 合法 metadata，无 notes
  })

  it('zip slip：只过滤不安全路径的文件，脚本其余条目照常导入', () => {
    const evil = ['evil/../pwn.js', 'evil//abs/x.js', 'evil/C:/x.js', 'evil/lib\\win.js']
    for (const p of evil) {
      const { scripts, skipped, ignored } = parseScriptsZip(makeZip({ 'evil/script.js': 'ok', [p]: 'x' }))
      expect(skipped).toEqual([]) // 脚本本身不再被拒
      expect(scripts).toHaveLength(1)
      expect(scripts[0].code).toBe('ok') // 不安全文件挡在脚本之外
      expect(ignored).toEqual([{ path: p, reason: expect.stringContaining('路径不安全') }])
    }
  })

  it('script.js 之外的条目（data/ 预留位、顶层散文件）未导入并汇进 ignored 报告', () => {
    const zip = makeZip({
      '示例脚本/script.js': 'console.log(1)',
      '示例脚本/data/whatever.json': '{}', // 备份语义预留位：忽略
      'loose.txt': '顶层散文件',
    })
    const { scripts, skipped, ignored } = parseScriptsZip(zip)
    expect(skipped).toEqual([])
    expect(scripts).toHaveLength(1)
    expect(scripts[0].code).toBe('console.log(1)')
    expect(ignored).toEqual([
      { path: 'loose.txt', reason: expect.stringContaining('顶层散文件') },
      { path: '示例脚本/data/whatever.json', reason: expect.stringContaining('非脚本条目') },
    ])
  })

  it('目录占位条目（path 以 / 结尾）不计入 ignored（与已导入脚本目录重名会误导）', () => {
    const zip = makeZip({
      '示例脚本/script.js': 'console.log(1)',
      '示例脚本/': '', // 机械目录占位
      'loose.txt': 'x', // 这条应被计入 ignored
    })
    const { scripts, ignored } = parseScriptsZip(zip)
    expect(scripts).toHaveLength(1)
    expect(ignored).toEqual([{ path: 'loose.txt', reason: expect.stringContaining('顶层散文件') }])
  })

  it('多脚本 zip：原则项（缺 script.js）与可导入者互不牵连', () => {
    const zip = makeZip({
      '好的/script.js': withMeta('好的', '// ok'),
      '坏的/notes.txt': '// 没有 script.js',
      '空源码/script.js': '', // 空源码：能解析出记录，不跳过
    })
    const { scripts, skipped } = parseScriptsZip(zip)
    expect(scripts.map((s) => s.name)).toEqual(['好的', '空源码'])
    expect(skipped.map((s) => s.dirName)).toEqual(['坏的'])
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
