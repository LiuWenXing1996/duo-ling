// zip-transfer.ts 单测：编解码纯函数（zip 格式、路径过滤、字段兜底、目录去重、指纹）。
// 解码侧「只拦原则项、尽量导入」。
// node 环境直跑（本模块零 chrome API）。
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

function validConfig() {
  return { matches: ['*://*/*'], allFrames: true, runAt: 'document_end' as const }
}

function manifestJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: ZIP_SCHEMA_VERSION,
    name: '示例脚本',
    config: validConfig(),
    exportedAt: 1726000000000,
    exporter: 'duoling/0.2.0',
    ...over,
  })
}

/** 一个最小合法的单脚本 zip */
function validSingleZip(over: Record<string, unknown> = {}): Uint8Array {
  return makeZip({
    '示例脚本/project.json': manifestJson(over),
    '示例脚本/script.js': 'console.log(1)',
  })
}

describe('buildScriptZip + parseScriptsZip 往返', () => {
  it('单脚本往返：name/config/code 原样保真', () => {
    const zip = buildScriptZip([{ name: '示例脚本', config: validConfig(), code: 'console.log(1)' }])
    const { scripts, skipped } = parseScriptsZip(zip)
    expect(skipped).toEqual([])
    expect(scripts).toHaveLength(1)
    expect(scripts[0].name).toBe('示例脚本')
    expect(scripts[0].config).toEqual(validConfig())
    expect(scripts[0].code).toBe('console.log(1)')
  })

  it('project.json 含 v/name/config/exportedAt/exporter，不含 uuid/enabled/source', () => {
    const zip = buildScriptZip(
      [{ name: 'A', config: validConfig(), code: 'x' }],
      { exporter: 'duoling/9.9.9', exportedAt: 123 },
    )
    const files = unzipSync(zip)
    const manifest = JSON.parse(strFromU8(files['A/project.json']!))
    expect(manifest).toMatchObject({ v: ZIP_SCHEMA_VERSION, name: 'A', exportedAt: 123, exporter: 'duoling/9.9.9' })
    expect(manifest.uuid).toBeUndefined()
    expect(manifest.enabled).toBeUndefined()
    expect(manifest.source).toBeUndefined()
    // script.js 真实展开（非内嵌 json）
    expect(strFromU8(files['A/script.js']!)).toBe('x')
  })

  it('多脚本同名：目录加 -2 后缀去重，真名各自保真（目录名 ≠ 真名）', () => {
    const zip = buildScriptZip([
      { name: '同名', config: validConfig(), code: '// 1' },
      { name: '同名', config: validConfig(), code: '// 2' },
    ])
    expect(Object.keys(unzipSync(zip)).filter((k) => k.endsWith('/project.json')).sort()).toEqual([
      '同名-2/project.json',
      '同名/project.json',
    ])
    const { scripts, skipped } = parseScriptsZip(zip)
    expect(skipped).toEqual([])
    expect(scripts.map((s) => s.name)).toEqual(['同名', '同名'])
    expect(scripts.map((s) => s.code)).toEqual(['// 1', '// 2'])
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
    for (const v of [1, 99, undefined, '2', null]) {
      const { scripts, skipped } = parseScriptsZip(validSingleZip({ v }))
      expect(skipped).toEqual([])
      expect(scripts).toHaveLength(1)
      expect(scripts[0].name).toBe('示例脚本')
    }
  })

  it('缺 project.json → 跳过（无 manifest 就构造不出记录，唯一原则项）', () => {
    const { scripts, skipped } = parseScriptsZip(makeZip({ '孤儿目录/script.js': 'x' }))
    expect(scripts).toEqual([])
    expect(skipped).toEqual([{ dirName: '孤儿目录', reason: expect.stringContaining('project.json') }])
  })

  it('project.json 非合法 JSON / 非对象 → 跳过（同属原则项）', () => {
    const badJson = parseScriptsZip(makeZip({ 'a/project.json': '{不是 json', 'a/script.js': 'x' }))
    expect(badJson.scripts).toEqual([])
    expect(badJson.skipped[0].reason).toContain('合法 JSON')

    const notObj = parseScriptsZip(makeZip({ 'b/project.json': '[1,2]', 'b/script.js': 'x' }))
    expect(notObj.scripts).toEqual([])
    expect(notObj.skipped[0].reason).toContain('不是对象')
  })

  it('缺 script.js → 跳过（无源码构造不出记录）', () => {
    const { scripts, skipped } = parseScriptsZip(
      makeZip({ 'a/project.json': manifestJson({ name: 'a' }), 'a/notes.txt': 'x' }),
    )
    expect(scripts).toEqual([])
    expect(skipped).toEqual([{ dirName: 'a', reason: expect.stringContaining('script.js') }])
  })

  it('name / config 缺失 → 补默认值导入 + notes 说明，不阻断', () => {
    const { scripts, skipped } = parseScriptsZip(
      makeZip({ 'my-dir/project.json': JSON.stringify({}), 'my-dir/script.js': 'x' }),
    )
    expect(skipped).toEqual([])
    expect(scripts).toHaveLength(1)
    // name ← 目录名；matches ← 空（留给编辑器补）
    expect(scripts[0]).toMatchObject({ name: 'my-dir' })
    expect(scripts[0].config.matches).toEqual([])
    const notes = (scripts[0].notes ?? []).join(' ')
    expect(notes).toContain('目录名')
    expect(notes).toContain('matches')
  })

  it('config 逐字段兜底：合法的 matches 保留，仅缺项补默认（合法 manifest 无 notes）', () => {
    const { scripts } = parseScriptsZip(validSingleZip({ config: { matches: ['*://a.com/*'] } }))
    expect(scripts[0].config).toEqual({ matches: ['*://a.com/*'], allFrames: true, runAt: 'document_end' })
    expect(scripts[0].notes).toBeUndefined()

    const clean = parseScriptsZip(validSingleZip())
    expect(clean.scripts[0].notes).toBeUndefined()
  })

  it('zip slip：只过滤不安全路径的文件，脚本其余条目照常导入', () => {
    const evil = [
      'evil/../pwn.js',
      'evil//abs/x.js',
      'evil/C:/x.js',
      'evil/lib\\win.js',
    ]
    for (const p of evil) {
      const { scripts, skipped, ignored } = parseScriptsZip(
        makeZip({
          'evil/project.json': manifestJson({ name: 'evil' }),
          'evil/script.js': 'ok',
          [p]: 'x',
        }),
      )
      expect(skipped).toEqual([]) // 脚本本身不再被拒
      expect(scripts).toHaveLength(1)
      expect(scripts[0].code).toBe('ok') // 不安全文件挡在脚本之外
      expect(ignored).toEqual([{ path: p, reason: expect.stringContaining('路径不安全') }])
    }
  })

  it('script.js 之外的条目（data/ 预留位、顶层散文件）未导入并汇进 ignored 报告', () => {
    const zip = makeZip({
      '示例脚本/project.json': manifestJson(),
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
      '示例脚本/project.json': manifestJson(),
      '示例脚本/script.js': 'console.log(1)',
      '示例脚本/': '', // 机械目录占位
      'loose.txt': 'x', // 这条应被计入 ignored
    })
    const { scripts, ignored } = parseScriptsZip(zip)
    expect(scripts).toHaveLength(1)
    expect(ignored).toEqual([{ path: 'loose.txt', reason: expect.stringContaining('顶层散文件') }])
  })

  it('多脚本 zip：原则项（缺 manifest / 缺源码）与可导入者互不牵连', () => {
    const zip = makeZip({
      '好的/project.json': manifestJson({ name: '好的' }),
      '好的/script.js': '// ok',
      '坏的/script.js': '// 没有 manifest',
      '空源码/project.json': manifestJson({ name: '空源码' }),
    })
    const { scripts, skipped } = parseScriptsZip(zip)
    expect(scripts.map((s) => s.name)).toEqual(['好的'])
    expect(skipped.map((s) => s.dirName)).toEqual(['坏的', '空源码'])
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
