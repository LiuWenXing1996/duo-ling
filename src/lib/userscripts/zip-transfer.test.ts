// zip-transfer.ts 单测：编解码纯函数（zip 格式、路径过滤、字段兜底、目录去重、指纹）。
// 2026-09-17 修订后解码侧「只拦原则项、尽量导入」，覆盖见 notes/content/userscript-zip-transfer.md。
// node 环境直跑（本模块零 chrome API）。
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

describe('parseScriptsZip 解析（尽量导入：只拦原则项，2026-09-17 修订）', () => {
  it('版本 v 任意值都放行（开发期无版本规范）', () => {
    for (const v of [2, 99, undefined, '1', null]) {
      const { scripts, skipped } = parseScriptsZip(validSingleZip({ v }))
      expect(skipped).toEqual([])
      expect(scripts).toHaveLength(1)
      expect(scripts[0].name).toBe('示例脚本')
    }
  })

  it('缺 project.json → 跳过（无 manifest 就构造不出记录，唯一原则项）', () => {
    const { scripts, skipped } = parseScriptsZip(makeZip({ '孤儿目录/files/main.js': 'x' }))
    expect(scripts).toEqual([])
    expect(skipped).toEqual([{ dirName: '孤儿目录', reason: expect.stringContaining('project.json') }])
  })

  it('project.json 非合法 JSON / 非对象 → 跳过（同属原则项）', () => {
    const badJson = parseScriptsZip(makeZip({ 'a/project.json': '{不是 json', 'a/files/main.js': 'x' }))
    expect(badJson.scripts).toEqual([])
    expect(badJson.skipped[0].reason).toContain('合法 JSON')

    const notObj = parseScriptsZip(makeZip({ 'b/project.json': '[1,2]', 'b/files/main.js': 'x' }))
    expect(notObj.scripts).toEqual([])
    expect(notObj.skipped[0].reason).toContain('不是对象')
  })

  it('name / entry / config 缺失 → 补默认值导入 + notes 说明，不阻断', () => {
    const { scripts, skipped } = parseScriptsZip(
      makeZip({ 'my-dir/project.json': JSON.stringify({}), 'my-dir/files/main.js': 'x' }),
    )
    expect(skipped).toEqual([])
    expect(scripts).toHaveLength(1)
    // name ← 目录名；entry ← 默认入口；matches ← 空（留给编辑器补）
    expect(scripts[0]).toMatchObject({ name: 'my-dir', entry: 'main.js' })
    expect(scripts[0].config.matches).toEqual([])
    const notes = (scripts[0].notes ?? []).join(' ')
    expect(notes).toContain('目录名')
    expect(notes).toContain('入口')
    expect(notes).toContain('matches')
  })

  it('config 逐字段兜底：合法的 matches 保留，仅缺项补默认（合法 manifest 无 notes）', () => {
    const { scripts } = parseScriptsZip(validSingleZip({ config: { matches: ['*://a.com/*'] } }))
    expect(scripts[0].config).toEqual({ matches: ['*://a.com/*'], allFrames: true, runAt: 'document_end' })
    expect(scripts[0].notes).toBeUndefined()

    const clean = parseScriptsZip(validSingleZip())
    expect(clean.scripts[0].notes).toBeUndefined()
  })

  it('zip slip：只过滤不安全路径的文件，脚本其余文件照常导入', () => {
    const evil = [
      'evil/files/../pwn.js',
      'evil/files//abs/x.js',
      'evil/files/C:/x.js',
      'evil/files/lib\\win.js',
    ]
    for (const p of evil) {
      const { scripts, skipped, ignored } = parseScriptsZip(
        makeZip({
          'evil/project.json': manifestJson({ name: 'evil' }),
          'evil/files/main.js': 'ok',
          [p]: 'x',
        }),
      )
      expect(skipped).toEqual([]) // 脚本本身不再被拒
      expect(scripts).toHaveLength(1)
      expect(scripts[0].files).toEqual({ 'main.js': 'ok' }) // 不安全文件挡在 files 之外
      expect(ignored).toEqual([{ path: p, reason: expect.stringContaining('路径不安全') }])
    }
  })

  it('files/ 之外的条目（data/ 预留位、顶层散文件）未导入并汇进 ignored 报告', () => {
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

  it('entry 不在 files / files 为空 → 仍导入（构建期失败留给写侧容忍 + 编辑器修）', () => {
    const missEntry = parseScriptsZip(
      makeZip({
        'a/project.json': manifestJson({ name: 'a', entry: 'index.js' }),
        'a/files/main.js': 'x',
      }),
    )
    expect(missEntry.skipped).toEqual([])
    expect(missEntry.scripts[0]).toMatchObject({ name: 'a', entry: 'index.js', files: { 'main.js': 'x' } })

    const empty = parseScriptsZip(makeZip({ 'b/project.json': manifestJson({ name: 'b' }) }))
    expect(empty.skipped).toEqual([])
    expect(empty.scripts[0].files).toEqual({})
  })

  it('多脚本 zip：原则项（缺 manifest）与可导入者互不牵连', () => {
    const zip = makeZip({
      '好的/project.json': manifestJson({ name: '好的' }),
      '好的/files/main.js': '// ok',
      '坏的/files/main.js': '// 没有 manifest',
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
