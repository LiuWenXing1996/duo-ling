#!/usr/bin/env node
// 用户脚本包生成器：把「写着具体内容的用户脚本」打成扩展可直接导入的 zip。
//
// 为什么要有它：手测 / 端测经常需要「有具体行为的脚本」——注入页面写标记、跑 DL 桥、多文件
// 构建、故意报错……在扩展里新建再手粘代码太慢，写好的内容也没法进 git 复用。于是：脚本源码
// 以普通目录形式躺在仓库根（uscript-samples/），本工具负责把它们打成 zip，扩展的
// 「工作台 → 脚本列表 → 导入 zip」直接吃。导入侧会跑 esbuild 构建，所以这里**不带产物**。
//
// 产出 zip 的布局必须与 src/lib/userscripts/zip-transfer.ts 的 buildScriptZip / parseScriptsZip
// 对齐（那一对函数才是编解码侧的真相源）：
//     <目录名>/project.json         脚本元信息（v / name / config / entry / exportedAt）
//     <目录名>/files/<相对路径>      文件树真实展开
//
// 本脚本**不 import** 那个模块，两条原因：① src 是扩展运行时代码，其扩展名省略的 TS 导入在
// node ESM 下解析不了；② 本工具刻意零依赖——没装 node_modules 也能跑（打测试包不该先 npm i）。
// 对齐靠两点保障：
//   ① 写完立刻回读 zip 自检（--no-verify 关）：解析中央目录 + 逐条比对本地文件头与 CRC；
//   ② 样例目录里的 project.json 与 ZipManifest 同形——改字段名时这两处要一起改。
//
// 用法见 `--help`；常规用法 `npm run pack:uscripts`（打包全部样例 → tmp/）。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// —— 常量：与 src/lib/userscripts/zip-transfer.ts 保持一致 ——

/** zip schema 版本（project.json.v） */
const ZIP_SCHEMA_VERSION = 1
/** 默认入口文件名（types.ts 的 ENTRY_DEFAULT） */
const ENTRY_DEFAULT = 'main.js'
/** 兜底匹配规则：全站（测试用最省事，正式脚本请写具体 pattern） */
const MATCHES_DEFAULT = ['*://*/*']
const DIR_NAME_MAX = 64

/** 固定 DOS 时间戳（2020-01-01 00:00）：zip 条目时间不参与比对，固定掉更可复现 */
const DOS_TIME = 0
const DOS_DATE = (40 << 9) | (1 << 5) | 1

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 默认源目录（仓库根的 uscript-samples/：未压缩的脚本源码，跟 git） */
const SAMPLES_DIR = join(REPO_ROOT, 'uscript-samples')

// ————————————————————————— zip 写入（STORE，零依赖）—————————————————————————

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 打成 zip（method = 0 STORE，flate 交给导入侧的 fflate 解压即可）。
 * 条目顺序 = 入参顺序（调用方已排序），故同样输入产出同样字节。
 */
function zipStore(entries) {
  const chunks = []
  const central = []
  let offset = 0

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const size = data.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // 本地文件头签名
    local.writeUInt16LE(20, 4) // 解压所需版本
    local.writeUInt16LE(0x0800, 6) // 标志位：文件名按 UTF-8 解析
    local.writeUInt16LE(0, 8) // 压缩方式：STORE
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18) // 压缩后
    local.writeUInt32LE(size, 22) // 压缩前
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // 扩展字段长度
    chunks.push(local, nameBuf, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0) // 中央目录签名
    cd.writeUInt16LE(20, 4) // 创建方版本
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(0, 10) // 压缩方式
    cd.writeUInt16LE(DOS_TIME, 12)
    cd.writeUInt16LE(DOS_DATE, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(size, 20)
    cd.writeUInt32LE(size, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30) // 扩展
    cd.writeUInt16LE(0, 32) // 注释
    cd.writeUInt16LE(0, 34) // 起始磁盘号
    cd.writeUInt16LE(0, 36) // 内部属性
    cd.writeUInt32LE(0, 38) // 外部属性
    cd.writeUInt32LE(offset, 42) // 本地头偏移
    central.push(cd, nameBuf)

    offset += 30 + nameBuf.length + size
  }

  const cdSize = central.reduce((n, b) => n + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // 中央目录结束签名
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // 注释长度

  return Buffer.concat([...chunks, ...central, eocd])
}

// ————————————————————————— 写后自检 —————————————————————————

/**
 * 回读刚写出的 zip 并逐条核对（防手写 zip 写出「能生成但导入侧读不出」的包）：
 * 走中央目录拿名字 / CRC / 本地头偏移，再跳到偏移处核对本地头与数据 CRC。
 * @returns {string[]} 问题列表（空 = 通过）
 */
function verifyZip(buf, expected) {
  const problems = []
  if (buf.length < 22 || buf.readUInt32LE(buf.length - 22) !== 0x06054b50) {
    return ['找不到中央目录结束记录（EOCD）']
  }
  const count = buf.readUInt16LE(buf.length - 12) // EOCD: +10 条目总数（+8 是本磁盘条目数）
  let p = buf.readUInt32LE(buf.length - 6)
  const seen = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return [`第 ${i + 1} 条中央目录签名不对`]
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    const crc = buf.readUInt32LE(p + 16)
    const size = buf.readUInt32LE(p + 24)
    const localOff = buf.readUInt32LE(p + 42)
    // 本地头：签名 + 名字一致 + STORE + 长度一致 + 数据 CRC 一致
    if (buf.readUInt32LE(localOff) !== 0x04034b50) problems.push(`${name}：本地头签名不对`)
    const localNameLen = buf.readUInt16LE(localOff + 26)
    const localName = buf.toString('utf8', localOff + 30, localOff + 30 + localNameLen)
    if (localName !== name) problems.push(`${name}：本地头名字不一致（${localName}）`)
    if (buf.readUInt16LE(localOff + 8) !== 0) problems.push(`${name}：压缩方式不是 STORE`)
    if (buf.readUInt32LE(localOff + 22) !== size) problems.push(`${name}：本地头与中央目录长度不一致`)
    const dataStart = localOff + 30 + localNameLen
    const data = buf.subarray(dataStart, dataStart + size)
    if (crc32(data) !== crc) problems.push(`${name}：数据 CRC 校验失败`)
    seen.push({ name, data })
    p += 46 + nameLen + extraLen + commentLen
  }
  if (seen.length !== expected.length) {
    problems.push(`条目数不符：zip 内 ${seen.length} 条，期望 ${expected.length} 条`)
  }
  for (let i = 0; i < Math.min(seen.length, expected.length); i++) {
    if (seen[i].name !== expected[i].name) {
      problems.push(`第 ${i + 1} 条名字不符：${seen[i].name} ≠ ${expected[i].name}`)
    } else if (!seen[i].data.equals(expected[i].data)) {
      problems.push(`${seen[i].name}：回读内容与源文件不一致`)
    }
  }
  return problems
}

// ————————————————————————— 素材目录 → 脚本定义 —————————————————————————

/** 目录名安全化：与 zip-transfer.sanitizeDirName 同规则 */
function sanitizeDirName(name) {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[\s.]+$/, '')
    .trim()
    .slice(0, DIR_NAME_MAX)
  return cleaned || 'script'
}

/** 项目内相对路径安全性（与 zip-transfer.isSafeRelPath 同规则） */
function isSafeRelPath(p) {
  return !!p && !p.startsWith('/') && !p.includes('\\') && !/^[a-zA-Z]:/.test(p) && !p.split('/').includes('..')
}

/** 递归收集目录下的文件（跳过点开头的隐藏项，路径用 / 分隔） */
function collectFiles(root) {
  const out = []
  const walk = (dir, prefix) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue
      const abs = join(dir, ent.name)
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(abs, rel)
      else if (ent.isFile()) out.push({ rel, abs })
    }
  }
  walk(root, '')
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * 读一个素材目录 → 脚本定义。
 *
 * 两种摆放都能吃：
 *   · 规范布局（推荐）：<dir>/project.json + <dir>/files/main.js …

 *   · 平铺布局：<dir>/*.js 直接是文件树（project.json 可选，缺失项按默认补）
 */
function readScriptDef(dir, overrides) {
  const absDir = resolve(dir)
  if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
    throw new Error(`不是目录或不存在：${dir}`)
  }
  const label = basename(absDir)

  let manifest = {}
  const manifestPath = join(absDir, 'project.json')
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (e) {
      throw new Error(`${label}/project.json 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 文件树根：优先 files/ 子目录，否则目录自身（平铺布局排除 project.json）
  const filesRoot = join(absDir, 'files')
  const nested = existsSync(filesRoot) && statSync(filesRoot).isDirectory()
  const root = nested ? filesRoot : absDir
  const files = {}
  const skipped = []
  for (const f of collectFiles(root)) {
    if (!nested && f.rel === 'project.json') continue
    if (!isSafeRelPath(f.rel)) {
      skipped.push(f.rel)
      continue
    }
    files[f.rel] = readFileSync(f.abs, 'utf8')
  }
  if (!Object.keys(files).length) throw new Error(`${label}：没收到任何源文件`)

  const name = overrides.name ?? (typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : label)
  const entry = overrides.entry ?? (typeof manifest.entry === 'string' && manifest.entry.trim() ? manifest.entry.trim() : ENTRY_DEFAULT)
  const config = {
    matches: overrides.matches?.length ? overrides.matches : strArray(manifest.config?.matches, MATCHES_DEFAULT),
    allFrames: typeof manifest.config?.allFrames === 'boolean' ? manifest.config.allFrames : true,
    runAt: ['document_start', 'document_end', 'document_idle'].includes(manifest.config?.runAt)
      ? manifest.config.runAt
      : 'document_end',
  }
  for (const key of ['excludeMatches', 'includeGlobs', 'excludeGlobs']) {
    const v = strArray(manifest.config?.[key], [])
    if (v.length) config[key] = v
  }
  // deps（UMD / 资源依赖 URL）：与 zip-transfer.coerceConfig 同步透传，别在打包侧剥掉
  const deps = strArray(manifest.config?.deps, [])
  if (deps.length) config.deps = deps

  return { label, name, entry, config, files, skipped }
}

/** 取字符串数组（非数组 / 非字符串 / 空串项一律丢弃；全丢则回退 fallback） */
function strArray(v, fallback) {
  const arr = Array.isArray(v) ? v.filter((x) => typeof x === 'string' && !!x) : []
  return arr.length ? arr : fallback
}

/** 脚本定义 → zip 条目（目录名重名加 -2 后缀，与 buildScriptZip 同规则） */
function toZipEntries(scripts, exportedAt) {
  const entries = []
  const used = new Set()
  for (const s of scripts) {
    let dir = sanitizeDirName(s.name)
    if (used.has(dir)) {
      for (let n = 2; ; n++) {
        if (!used.has(`${dir}-${n}`)) {
          dir = `${dir}-${n}`
          break
        }
      }
    }
    used.add(dir)
    const manifest = {
      v: ZIP_SCHEMA_VERSION,
      name: s.name,
      config: s.config,
      entry: s.entry,
      exportedAt,
      exporter: 'duoling/pack-uscripts',
    }
    entries.push({ name: `${dir}/project.json`, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') })
    for (const rel of Object.keys(s.files).sort()) {
      entries.push({ name: `${dir}/files/${rel}`, data: Buffer.from(s.files[rel], 'utf8') })
    }
  }
  return entries
}

// ————————————————————————— CLI —————————————————————————

const HELP = `用户脚本包生成器：把脚本素材目录打成扩展可导入的 zip

用法：
  npm run pack:uscripts                     # 打包仓库根 uscript-samples/ 下全部样例 → tmp/
  npm run pack:uscripts -- --list           # 列出可用样例
  npm run pack:uscripts -- <目录> [<目录>…]  # 只打指定目录（素材目录，不是 zip）
  npm run pack:uscripts -- <目录> -o 包.zip  # 指定输出路径

选项：
  -o, --out <文件>        输出 zip 路径（默认 tmp/uscripts-<时间戳>.zip）
  -n, --name <名字>       覆盖脚本名（仅单目录时可用）
  -m, --match <pattern>   覆盖匹配规则，可重复（仅单目录时可用）
  -e, --entry <文件>      覆盖入口文件（仅单目录时可用）
      --list              列出样例目录并退出
      --no-verify         跳过写后回读自检
  -h, --help              显示本帮助

素材目录两种摆法（project.json 可选，缺字段按默认补：全站匹配 / allFrames / document_end）：
  <目录>/project.json + <目录>/files/main.js …   # 规范布局，与导出 zip 解开的形态一致
  <目录>/main.js …                                # 平铺布局，直接写源码
`

function parseArgs(argv) {
  const opts = { dirs: [], matches: [], verify: true, list: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '-h':
      case '--help':
        process.stdout.write(HELP)
        process.exit(0)
      case '--list':
        opts.list = true
        break
      case '--no-verify':
        opts.verify = false
        break
      case '-o':
      case '--out':
        opts.out = argv[++i]
        break
      case '-n':
      case '--name':
        opts.name = argv[++i]
        break
      case '-m':
      case '--match':
        opts.matches.push(argv[++i])
        break
      case '-e':
      case '--entry':
        opts.entry = argv[++i]
        break
      default:
        if (a.startsWith('-')) throw new Error(`不认识的选项：${a}（--help 看用法）`)
        opts.dirs.push(a)
    }
  }
  return opts
}

function listSamples() {
  if (!existsSync(SAMPLES_DIR)) return []
  return readdirSync(SAMPLES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
}

function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (opts.list) {
    const names = listSamples()
    process.stdout.write(
      names.length
        ? `可用样例（${rel(SAMPLES_DIR)}/）：\n${names.map((n) => `  · ${n}`).join('\n')}\n`
        : '（没有样例目录）\n',
    )
    return
  }

  const dirs = opts.dirs.length ? opts.dirs : listSamples().map((n) => join(SAMPLES_DIR, n))
  if (!dirs.length) throw new Error('没有可打包的目录：uscript-samples/ 是空的，或手动指定目录')

  const single = dirs.length === 1
  if (!single && (opts.name || opts.entry || opts.matches.length)) {
    throw new Error('--name / --entry / --match 只在打包单个目录时可用')
  }

  const scripts = dirs.map((d) => readScriptDef(d, opts))

  const exportedAt = Date.now()
  const entries = toZipEntries(scripts, exportedAt)
  const zip = zipStore(entries)

  const out = resolve(opts.out ?? join(REPO_ROOT, 'tmp', `uscripts-${stamp()}.zip`))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, zip)
  if (!existsSync(out)) throw new Error(`写出失败：${out}`)

  if (opts.verify) {
    const problems = verifyZip(readFileSync(out), entries)
    if (problems.length) {
      throw new Error(`zip 自检未通过（文件已写出但可能导入失败）：\n  ${problems.join('\n  ')}`)
    }
  }

  // —— 汇报 ——
  const fileCount = scripts.reduce((n, s) => n + Object.keys(s.files).length, 0)
  const lines = scripts.map((s) => {
    const warn = []
    if (!(s.entry in s.files)) warn.push(`入口 ${s.entry} 不在文件树里（导入后需在编辑器补）`)
    if (s.skipped.length) warn.push(`跳过不安全路径 ${s.skipped.length} 个`)
    return `  · ${s.name}  入口 ${s.entry}  ${Object.keys(s.files).length} 文件  匹配 ${s.config.matches.join(' ')}${warn.length ? `  ⚠ ${warn.join('；')}` : ''}`
  })
  process.stdout.write(
    [
      `已生成 ${rel(out)}（${scripts.length} 个脚本 / ${fileCount} 个文件 / ${(zip.length / 1024).toFixed(1)} KB${opts.verify ? '，自检通过' : '，未自检'}）`,
      ...lines,
      '导入：工作台 → 脚本列表 → 导入 → 「选择 zip 文件…」选这个文件，或「输入文件路径…」直接把下面这行路径粘进去：',
      `  ${out}`,
      '（导入后默认未启用，需手动启用）',
      '',
    ].join('\n'),
  )
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

function rel(p) {
  return p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p
}

try {
  main()
} catch (e) {
  process.stderr.write(`pack-uscripts 失败：${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
}
