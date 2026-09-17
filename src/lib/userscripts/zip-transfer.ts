// 用户脚本 zip 导入导出的纯函数编解码层（docs/userscript-zip-transfer.md §3/§5.2）。
//
// 编码在 UI 导出侧（工作台标签页，userscript:getProject 只读命令取数后打包），
// 解码在 offscreen 导入侧（单写方，state:import → project-write.importScriptsZip），
// 两侧共用本模块——故这里**不得 import 任何 chrome API**（offscreen 与单测的 node 环境
// 都要能跑）。
//
// 安全：zip slip 防护在本模块的解码层做拦截（.. 段 / 绝对路径 / 盘符 / 反斜杠）。
//
// 2026-09-17 语义修订（老大拍板「不是原则项的阻断，尽量导入脚本」）：解码层**只拦原则项**——
// 没有可解析的 project.json（无 manifest 就构造不出任何记录）。其余一律放行：
//  · 路径不安全的**文件**被过滤（进 ignored 报告），脚本其余文件照常导入；
//  · 版本 v、字段 name/entry/config 缺失或非法 → 补默认值导入，报告里说明，留给编辑器修；
//  · files 为空 / entry 不在 files → 放行（构建期失败由写侧容忍 + 报告说明）。
// 故导入侧的「校验」不再是拦截，而是**尽量修复 + 报告**。
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { ENTRY_DEFAULT } from './types'
import type { ScriptConfig } from './types'

/** zip schema 版本（project.json.v；导出侧写入。**解码侧不据此拦截**——开发期无版本规范，见文件头） */
export const ZIP_SCHEMA_VERSION = 1

/** zip 目录名长度上限（超长截断，防极端名称撑爆解压路径） */
const DIR_NAME_MAX = 64

/** project.json（zip 内）的形状：定稿 §3——bundle/uuid/enabled/createdAt 不进 zip */
export interface ZipManifest {
  v: number
  name: string
  config: ScriptConfig
  entry: string
  exportedAt: number
  /** 导出方标识 `duoling/<扩展版本>`，排障用 */
  exporter?: string
}

/** 单脚本的中间形态（编码入参 / 解码出参；真名以 name 为准，zip 目录名仅展示） */
export interface ZipScriptPayload {
  name: string
  config: ScriptConfig
  entry: string
  files: Record<string, string>
}

/** 解码出的一个待导入脚本（notes 承载导入期兜底/提示，随成功条目一并展示） */
export interface ParsedScript extends ZipScriptPayload {
  /** 导入期需要告知用户的兜底与提示（字段缺失已补默认等），非阻断 */
  notes?: string[]
}

/** 解码时被跳过的顶层目录——**只剩原则项**（缺 project.json / 非合法 JSON / 非对象 manifest） */
export interface ParsedSkip {
  /** zip 顶层目录名（≠真名，仅排障展示） */
  dirName: string
  reason: string
}

/** 解码时未导入的文件（顶层散文件 / 非 files/ 条目 / 路径不安全被过滤）——仅展示，不阻断脚本导入 */
export interface ParsedIgnored {
  /** zip 内原始路径 */
  path: string
  reason: string
}

export interface ScriptsZipParse {
  scripts: ParsedScript[]
  skipped: ParsedSkip[]
  ignored: ParsedIgnored[]
}

// —— 编码（导出侧） ——

/**
 * 把若干脚本打成 zip。每脚本一个平级目录（project.json + files/ 真实文件树展开）；
 * 目录名 = 脚本名安全化，重名加 -2 后缀（定稿 §3）；data/ 预留位 v1 恒不写入。
 * files 里的路径在写侧已校验过，这里对非法键兜底跳过（不阻断导出）。
 */
export function buildScriptZip(
  scripts: ZipScriptPayload[],
  meta?: { exportedAt?: number; exporter?: string },
): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  const usedDirs = new Set<string>()
  for (const s of scripts) {
    const dir = uniqueDirName(sanitizeDirName(s.name), usedDirs)
    const manifest: ZipManifest = {
      v: ZIP_SCHEMA_VERSION,
      name: s.name,
      config: s.config,
      entry: s.entry,
      exportedAt: meta?.exportedAt ?? Date.now(),
      exporter: meta?.exporter,
    }
    entries[`${dir}/project.json`] = strToU8(JSON.stringify(manifest, null, 2))
    for (const [p, content] of Object.entries(s.files)) {
      if (!isSafeRelPath(p)) continue
      entries[`${dir}/files/${p}`] = strToU8(content)
    }
  }
  return zipSync(entries)
}

/** 目录名安全化：替换 Windows 保留字符与控制符、去结尾点/空白、截断；空值兜底 */
export function sanitizeDirName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[\s.]+$/, '')
    .trim()
    .slice(0, DIR_NAME_MAX)
  return cleaned || 'script'
}

/** 重名目录去重：`x` 已占用 → `x-2` → `x-3` …（定稿 §3 的 -2 后缀规则） */
function uniqueDirName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

/**
 * 项目内相对路径安全性（zip slip 第一道闸）：
 * 非空、不以 / 开头、不含反斜杠（zip 规范用 / ，反斜杠是 Windows 路径混入的信号）、
 * 不含盘符前缀、不含 .. 段。
 */
function isSafeRelPath(p: string): boolean {
  return (
    !!p &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    !/^[a-zA-Z]:/.test(p) &&
    !p.split('/').includes('..')
  )
}

// —— 解码（导入侧） ——

/**
 * 解析脚本 zip（2026-09-17 修订：**只拦原则项，尽量导入**，见文件头）：
 *  · 顶层散条目与 files/ 之外的条目（含 data/ 预留位）→ 未导入，进 ignored 报告；
 *  · 路径不安全的**文件**（zip slip 特征）→ 只过滤该文件（进 ignored 报告），脚本其余照常导入；
 *  · 版本 v / name / entry / config 缺失或非法 → **补默认值导入**，原因写进 notes，留给编辑器修；
 *  · 目录名 ≠ 真名；name 缺失时以目录名兜底；
 *  · **唯一跳过**：缺 project.json、非合法 JSON、或不是对象（无 manifest 就构造不出任何记录）。
 * 本函数不做构建校验——构建失败由写侧容忍并报告（project-write.importScriptsZip）。
 */
export function parseScriptsZip(bytes: Uint8Array): ScriptsZipParse {
  const unzipped = unzipSync(bytes)
  const scripts: ParsedScript[] = []
  const skipped: ParsedSkip[] = []
  // 未导入的文件（仅展示，不计入成功/失败）：顶层散文件 + 脚本目录内的非 files/ 条目 + 路径不安全被过滤的文件。
  // 目录占位条目（path 以 / 结尾）不计入——它只是机械目录项，且与已导入的脚本目录重名会误导。
  const ignored: ParsedIgnored[] = []

  // 按顶层目录分组：path 去掉首个段后按目录归堆（目录占位条目与顶层散文件先分流）
  const groups = new Map<string, Map<string, Uint8Array>>()
  for (const [path, content] of Object.entries(unzipped)) {
    if (path.endsWith('/')) continue
    const slash = path.indexOf('/')
    if (slash <= 0) {
      ignored.push({ path, reason: '顶层散文件（非脚本条目，未导入）' })
      continue
    }
    const top = path.slice(0, slash)
    const rest = path.slice(slash + 1)
    if (!groups.has(top)) groups.set(top, new Map())
    groups.get(top)!.set(rest, content)
  }

  const skip = (dirName: string, reason: string) => skipped.push({ dirName, reason })

  for (const [top, filesByDir] of groups) {
    // —— 唯一的原则项：没有可解析的 manifest，就构造不出记录 ——
    const manifestRaw = filesByDir.get('project.json')
    if (!manifestRaw) {
      skip(top, '缺少 project.json')
      continue
    }
    let parsedManifest: unknown
    try {
      parsedManifest = JSON.parse(strFromU8(manifestRaw))
    } catch {
      skip(top, 'project.json 不是合法 JSON')
      continue
    }
    if (typeof parsedManifest !== 'object' || parsedManifest === null || Array.isArray(parsedManifest)) {
      skip(top, 'project.json 不是对象（无法识别为脚本 manifest）')
      continue
    }
    const manifest = parsedManifest as Partial<ZipManifest>
    const notes: string[] = []

    // 字段兜底：拿不到就补默认值 + 报告说明，不阻断（留给编辑器修）
    let name = typeof manifest.name === 'string' ? manifest.name.trim() : ''
    if (!name) {
      name = top
      notes.push(`缺少脚本名（name），已用目录名「${top}」`)
    }
    const entryField = typeof manifest.entry === 'string' ? manifest.entry.trim() : ''
    const entry = entryField || ENTRY_DEFAULT
    if (!entryField) notes.push(`缺少入口文件（entry），已用默认入口「${ENTRY_DEFAULT}」`)
    const { config, note: configNote } = coerceConfig(manifest.config)
    if (configNote) notes.push(configNote)

    // 只认 files/ 前缀；data/ 等其余条目未导入；路径不安全的文件过滤掉、不整目录拒绝
    const files: Record<string, string> = {}
    for (const [rest, content] of filesByDir) {
      if (!rest.startsWith('files/')) {
        if (rest !== 'project.json') {
          ignored.push({
            path: `${top}/${rest}`,
            reason: '脚本目录内的非 files/ 条目（如 data/ 预留位），未导入',
          })
        }
        continue
      }
      const rel = rest.slice('files/'.length)
      if (!rel || rel.endsWith('/')) continue
      if (!isSafeRelPath(rel)) {
        ignored.push({
          path: `${top}/files/${rel}`,
          reason: '路径不安全（含 .. 段 / 绝对路径 / 反斜杠 / 盘符），已过滤',
        })
        continue
      }
      files[rel] = strFromU8(content)
    }

    scripts.push({ name, config, entry, files, ...(notes.length ? { notes } : {}) })
  }

  return { scripts, skipped, ignored }
}

/**
 * 尽力把 project.json.config 收成合法 ScriptConfig：逐字段取用 + 缺项补默认。
 * 不因配置缺失/非法阻断导入——匹配规则为空只提示，留给编辑器补全后再启用。
 */
function coerceConfig(raw: unknown): { config: ScriptConfig; note?: string } {
  const c = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const matches = strArray(c.matches)
  const config: ScriptConfig = {
    matches,
    allFrames: typeof c.allFrames === 'boolean' ? c.allFrames : true,
    runAt: c.runAt === 'document_start' || c.runAt === 'document_idle' ? c.runAt : 'document_end',
  }
  const excludeMatches = strArray(c.excludeMatches)
  if (excludeMatches.length) config.excludeMatches = excludeMatches
  const includeGlobs = strArray(c.includeGlobs)
  if (includeGlobs.length) config.includeGlobs = includeGlobs
  const excludeGlobs = strArray(c.excludeGlobs)
  if (excludeGlobs.length) config.excludeGlobs = excludeGlobs
  return {
    config,
    ...(matches.length ? {} : { note: '配置缺少匹配规则（matches），补全后再启用' }),
  }
}

/** 取字符串数组（非数组 / 非字符串 / 空串项一律丢弃） */
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []
}

// —— 传输与指纹（两侧共用的小工具） ——

/** Uint8Array → base64（分块避免 String.fromCharCode 爆栈；zip 几 MB 也在安全余量内） */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** base64 → Uint8Array（offscreen 解码入口用） */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * 内容指纹（定稿 §5.6 重复导入提示用）：entry + files（键排序后）整体 SHA-256。
 * 只提示不拦截——重复导入 = 独立副本是合理场景。
 */
export async function filesFingerprint(entry: string, files: Record<string, string>): Promise<string> {
  const keys = Object.keys(files).sort()
  const material = JSON.stringify([entry, keys, keys.map((k) => files[k])])
  const digest = await crypto.subtle.digest('SHA-256', strToU8(material))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
