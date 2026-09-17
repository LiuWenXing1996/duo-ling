// zip-transfer.ts 单测：编解码纯函数（zip 格式、zip slip 防护、schema 校验、目录去重、指纹）。
// docs/userscript-zip-transfer.md §3/§5.2/§5.6 的层 1 覆盖；node 环境直跑（本模块零 chrome API）。
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  ZIP_SCHEMA_VERSION,
  base64ToBytes,
  buildScriptZip,
  bytesToBase64,
  filesFingerprint,
  parseScriptsZip,
  sanitizeDirName,
} from './zip-transfer'

/** 用字符串 entries 打一个 zip（测试辅助） */
function makeZip(entries: Record<string, string>): Uint8Array {
  const u8: Record<string, Uint8Array> = {}
  for (const [k, v] of Object.entries(entries)) u8[k] = strToU8(v)
  return zipSync(u8)
}

function validConfig() {
  return { matches: ['*://*/*'], allFrames: true, runAt: 'document_end' as const }
}

function manifestJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: ZIP_SCHEMA_VERSION,
    name: '示例脚本',
    config: validConfig(),
    entry: 'main.js',
    exportedAt: 1726000000000,
    exporter: 'duoling/0.1.0',
    ...over,
  })
}

/** 一个最小合法的单脚本 zip */
function validSingleZip(over: Record<string, unknown> = {}): Uint8Array {
  return makeZip({
    '示例脚本/project.json': manifestJson(over),
    '示例脚本/files/main.js': 'console.log(1)',
    '示例脚本/files/lib/util.js': 'export const x = 1',
  })
}

describe('buildScriptZip + parseScriptsZip 往返', () => {
  it('单脚本往返：name/config/entry/files 原样保真', () => {
    const zip = buildScriptZip([
      { name: '示例脚本', config: validConfig(), entry: 'main.js', files: { 'main.js': 'console.log(1)' } },
    ])
    const { scripts, skipped } = parseScriptsZip(zip)
    expect(skipped).toEqual([])
    expect(scripts).toHaveLength(1)
    expect(scripts[0].name).toBe('示例脚本')
    expect(scripts[0].config).toEqual(validConfig())
    expect(scripts[0].entry).toBe('main.js')
    expect(scripts[0].files).toEqual({ 'main.js': 'console.log(1)' })
  })

  it('project.json 含 v/name/config/entry/exportedAt/exporter，不含 uuid/enabled/bundle（定稿 §3）', () => {
    const zip = buildScriptZip(
      [{ name: 'A', config: validConfig(), entry: 'main.js', files: { 'main.js': 'x' } }],
      { exporter: 'duoling/9.9.9', exportedAt: 123 },
    )
    const files = unzipSync(zip)
    const manifest = JSON.parse(strFromU8(files['A/project.json']!))
    expect(manifest).toMatchObject({ v: 1, name: 'A', entry: 'main.js', exportedAt: 123, exporter: 'duoling/9.9.9' })
    expect(manifest.uuid).toBeUndefined()
    expect(manifest.enabled).toBeUndefined()
    expect(manifest.bundle).toBeUndefined()
    // files 真实展开（非内嵌 json）
    expect(strFromU8(files['A/files/main.js']!)).toBe('x')
  })

  it('多脚本同名：目录加 -2 后缀去重，真名各自保真（目录名 ≠ 真名）', () => {
    const zip = buildScriptZip([
      { name: '同名', config: validConfig(), entry: 'main.js', files: { 'main.js': '// 1' } },
      { name: '同名', config: validConfig(), entry: 'main.js', files: { 'main.js': '// 2' } },
    ])
    expect(Object.keys(unzipSync(zip)).filter((k) => k.endsWith('/project.json')).sort()).toEqual([
      '同名-2/project.json',
      '同名/project.json',
    ])
    const { scripts, skipped } = parseScriptsZip(zip)
    expect(skipped).toEqual([])
    expect(scripts.map((s) => s.name)).toEqual(['同名', '同名'])
    expect(scripts.map((s) => s.files['main.js'])).toEqual(['// 1', '// 2'])
  })

  it('目录名做 Windows 保留字符安全化', () => {
    expect(sanitizeDirName('a/b:c*d?"<>|')).toBe('a_b_c_d_____')
    expect(sanitizeDirName('  结尾点.  ')).toBe('结尾点')
    expect(sanitizeDirName('///')).toBe('___') // 全部是保留字符：替换后仍可作为目录名
    expect(sanitizeDirName('  ')).toBe('script') // 全空白才兜底
    expect(sanitizeDirName('x'.repeat(100))).toHaveLength(64)
  })
})

describe('parseScriptsZip 解析安全（定稿 §5.2）', () => {
  it('v 大于本实现 → 跳过并提示升级', () => {
    const { scripts, skipped } = parseScriptsZip(validSingleZip({ v: 2 }))
    expect(scripts).toEqual([])
    expect(skipped).toEqual([{ dirName: '示例脚本', reason: expect.stringContaining('升级') }])
  })

  it('v 缺失 / 非 number → 跳过带原因', () => {
    for (const v of [undefined, '1', null]) {
      const over: Record<string, unknown> = { v }
      const { scripts, skipped } = parseScriptsZip(validSingleZip(over))
      expect(scripts).toEqual([])
      expect(skipped[0].reason).toContain('schema 版本')
    }
  })

  it('缺 project.json → 跳过', () => {
    const { scripts, skipped } = parseScriptsZip(makeZip({ '孤儿目录/files/main.js': 'x' }))
    expect(scripts).toEqual([])
    expect(skipped).toEqual([{ dirName: '孤儿目录', reason: expect.stringContaining('project.json') }])
  })

  it('name / entry / config.matches 缺失或非法 → 各自跳过带原因', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ name: '' }, 'name'],
      [{ entry: '' }, 'entry'],
      [{ config: { matches: [], allFrames: true, runAt: 'document_end' } }, 'matches'],
      [{ config: null }, 'matches'],
    ]
    for (const [over, keyword] of cases) {
      const { scripts, skipped } = parseScriptsZip(validSingleZip(over))
      expect(scripts).toEqual([])
      expect(skipped[0].reason).toContain(keyword)
    }
  })

  it('zip slip：files 内含 .. 段 / 绝对路径 / 盘符的脚本整目录拒绝', () => {
    const evil = [
      'evil/files/../pwn.js',
      'evil/files//abs/x.js',
      'evil/files/C:/x.js',
      'evil/files/lib\\win.js',
    ]
    for (const p of evil) {
      const { scripts, skipped } = parseScriptsZip(
        makeZip({ 'evil/project.json': manifestJson({ name: 'evil' }), [p]: 'x' }),
      )
      expect(scripts).toEqual([])
      expect(skipped[0].reason).toContain('zip slip')
    }
  })

  it('files/ 之外的条目（data/ 预留位、顶层散文件）忽略不报错，并汇进 ignored 报告', () => {
    const zip = makeZip({
      '示例脚本/project.json': manifestJson(),
      '示例脚本/files/main.js': 'console.log(1)',
      '示例脚本/data/whatever.json': '{}', // 备份语义预留位：v1 忽略
      'loose.txt': '顶层散文件',
    })
    const { scripts, skipped, ignored } = parseScriptsZip(zip)
    expect(skipped).toEqual([])
    expect(scripts).toHaveLength(1)
    expect(scripts[0].files).toEqual({ 'main.js': 'console.log(1)' })
    expect(ignored).toEqual([
      { path: 'loose.txt', reason: expect.stringContaining('顶层散文件') },
      { path: '示例脚本/data/whatever.json', reason: expect.stringContaining('非 files/') },
    ])
  })

  it('目录占位条目（path 以 / 结尾）不计入 ignored（与已导入脚本目录重名会误导）', () => {
    const zip = makeZip({
      '示例脚本/project.json': manifestJson(),
      '示例脚本/files/main.js': 'console.log(1)',
      '示例脚本/': '', // 机械目录占位
      'loose.txt': 'x', // 这条应被计入 ignored
    })
    const { scripts, ignored } = parseScriptsZip(zip)
    expect(scripts).toHaveLength(1)
    expect(ignored).toEqual([{ path: 'loose.txt', reason: expect.stringContaining('顶层散文件') }])
  })

  it('entry 不在 files 中 → 跳过；files 为空 → 跳过', () => {
    const missEntry = parseScriptsZip(
      makeZip({
        'a/project.json': manifestJson({ name: 'a', entry: 'index.js' }),
        'a/files/main.js': 'x',
      }),
    )
    expect(missEntry.scripts).toEqual([])
    expect(missEntry.skipped[0].reason).toContain('入口文件')

    const empty = parseScriptsZip(makeZip({ 'b/project.json': manifestJson({ name: 'b' }) }))
    expect(empty.scripts).toEqual([])
    expect(empty.skipped[0].reason).toContain('files 为空')
  })

  it('多脚本 zip：合法与非法混排时逐脚本独立判定（互不牵连）', () => {
    const zip = makeZip({
      '好的/project.json': manifestJson({ name: '好的' }),
      '好的/files/main.js': '// ok',
      '坏的/project.json': manifestJson({ name: '坏的', v: 99 }),
      '坏的/files/main.js': '// nope',
    })
    const { scripts, skipped } = parseScriptsZip(zip)
    expect(scripts.map((s) => s.name)).toEqual(['好的'])
    expect(skipped.map((s) => s.dirName)).toEqual(['坏的'])
  })
})

describe('base64 传输与内容指纹', () => {
  it('bytesToBase64 / base64ToBytes 往返保真（含非 ASCII 字节）', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 128])
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })

  it('filesFingerprint：内容相同同指纹（键序无关），内容不同指纹不同', async () => {
    const a = await filesFingerprint('main.js', { 'b.js': '2', 'a.js': '1' })
    const b = await filesFingerprint('main.js', { 'a.js': '1', 'b.js': '2' })
    const c = await filesFingerprint('main.js', { 'a.js': '1', 'b.js': '3' })
    const d = await filesFingerprint('other.js', { 'a.js': '1', 'b.js': '2' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).not.toBe(d)
  })
})
