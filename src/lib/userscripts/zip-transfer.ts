// 用户脚本 zip 导入导出的纯函数编解码层。
//
// 编码在导出侧（offscreen 的 fs:exportZip 逐个取工作树源码后打包），解码在导入侧
// （单写方，state:import → project-write.importScriptsZip）。两侧共用本模块——
// 故这里**不得 import 任何 chrome API**（offscreen 与单测的 node 环境都要能跑）。
//
// 编码布局：每脚本一个平级目录，目录内一份 `<目录名>.user.js`（见 buildScriptZip）。
//
// 解码**不看这个布局**：扫全包，凡路径以 `.user.js` 结尾的条目即源码——摊在 zip 根、
// 嵌在多层子目录、同一个目录里放好几份，都照收，各自成一条导入记录。其余条目
// （含目录占位条目）一律进未导入报告。摆放自由度最大，代价是目录名不参与取名。
//
// 解码层**不拦任何脚本**：没有任何「构造不出记录」的情形——脚本名取自源码 `// @name`
// （缺则用文件名兜底），配置由源码里的 `// ==UserScript==` 块派生（无块按默认配置）。
// 这些缺失一律只产出 notes 提示，不阻断导入（缺 matches 也照装，提示用户补全）。
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { SCRIPT_EXT, defaultConfig } from './types'
import type { ScriptConfig } from './types'
import { resolveConfigFromSource } from './metadata'

/** zip schema 版本（历史字段；**解码侧不据此拦截**——开发期无版本规范） */
export const ZIP_SCHEMA_VERSION = 2

/** zip 目录名长度上限（超长截断，防极端名称撑爆解压路径） */
const DIR_NAME_MAX = 64

/** 单脚本的编码入参（zip 内只有一份源码，name 决定目录名与文件名，配置由源码派生） */
export interface ZipScriptPayload {
  name: string
  code: string
}

/** 解码出的一个待导入脚本（notes 承载导入期兜底/提示，随成功条目一并展示） */
export interface ParsedScript extends ZipScriptPayload {
  /** 配置完全由源码里的 `// ==UserScript==` 块派生（无块则用默认配置） */
  config: ScriptConfig
  /** 导入期需要告知用户的兜底与提示（字段缺失已补默认等），非阻断 */
  notes?: string[]
}

/** 解码时未导入的条目（非 `.user.js` 文件；目录占位条目不计入）——仅展示，不阻断脚本导入 */
export interface ParsedIgnored {
  /** zip 内原始路径 */
  path: string
  reason: string
}

export interface ScriptsZipParse {
  scripts: ParsedScript[]
  ignored: ParsedIgnored[]
}

// —— 编码（导出侧） ——

/**
 * 把若干脚本打成 zip。布局：每脚本一个平级目录，目录内只有一份 `<目录名>.user.js`。
 * 目录名与文件名同源（同一套安全化），重名目录加 -2 后缀 —— 两个同名脚本各自进独立目录，
 * 文件名不必再区分。配置不进 zip（导入时从源码派生）。
 */
export function buildScriptZip(scripts: ZipScriptPayload[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  const usedDirs = new Set<string>()
  for (const s of scripts) {
    // 名字本身已带 .user.js 后缀时先剥掉，免得导出成 foo.user.js.user.js
    const base = sanitizeDirName(s.name.replace(/\.user\.js$/i, ''))
    const dir = uniqueDirName(base, usedDirs)
    entries[`${dir}/${base}${SCRIPT_EXT}`] = strToU8(s.code)
  }
  return zipSync(entries)
}

/** 名字安全化（目录名与文件名共用）：替换 Windows 保留字符与控制符、去结尾点/空白、截断；空值兜底 */
export function sanitizeDirName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[\s.]+$/, '')
    .trim()
    .slice(0, DIR_NAME_MAX)
  return cleaned || 'script'
}

/** 重名目录去重：`x` 已占用 → `x-2` → `x-3` …（-2 后缀规则） */
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

// —— 解码（导入侧） ——

/**
 * 路径是否算源码条目：**以 `.user.js` 结尾即算**，后缀比较忽略大小写
 * （外部包可能写成 `.User.js`，与「尽量导入」的取向一致）。
 * 不看层级、不看所在目录、不看同目录还有几份——一个条目一条记录。
 */
function isSourcePath(path: string): boolean {
  return path.toLowerCase().endsWith(SCRIPT_EXT)
}

/** 源码没写 `@name` 时的兜底名：取路径末段并剥掉 `.user.js` 后缀（剥空则用 `script`） */
function fallbackNameFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.replace(/\.user\.js$/i, '').trim() || 'script'
}

/**
 * 解析脚本 zip（**扫全包，只认 `.user.js` 后缀**）：
 *  · 路径以 `.user.js` 结尾的条目 → 每个一条记录（不限层级、不限同目录份数）；
 *  · 其余文件 → 未导入，进 ignored 报告（逐条列出，用户自己看得出该怎么改）；
 *  · 目录占位条目（path 以 / 结尾）→ 不计入报告（只是机械目录项，报出来纯噪声）；
 *  · 配置由源码里的 `// ==UserScript==` 块派生；缺块则按默认配置导入，缺 matches 提示补全；
 *  · 脚本名缺 `@name` 时以文件名（去后缀）兜底。
 * 本函数不做语法校验——坏脚本照样导入（保存即注入的语义），运行期报错走错误日志。
 */
export function parseScriptsZip(bytes: Uint8Array): ScriptsZipParse {
  const unzipped = unzipSync(bytes)
  const scripts: ParsedScript[] = []
  const ignored: ParsedIgnored[] = []

  // 按路径排序遍历：导入顺序不随 zip 写入顺序漂移，报告读起来也可复现
  for (const path of Object.keys(unzipped).sort()) {
    if (path.endsWith('/')) continue // 目录占位条目：不是文件
    if (!isSourcePath(path)) {
      ignored.push({ path, reason: `非 ${SCRIPT_EXT} 文件，未导入` })
      continue
    }

    const code = strFromU8(unzipped[path]!)
    // 配置完全由源码里的 // ==UserScript== 块派生（单一归一化路径），无块则按默认配置
    const resolved = resolveConfigFromSource(code, defaultConfig([]))
    let name = resolved.name?.trim()
    const notes: string[] = [...resolved.notes]
    if (!name) {
      name = fallbackNameFromPath(path)
      notes.push(`缺少脚本名（name），已用文件名「${name}」`)
    }
    if (!resolved.config.matches.length) {
      notes.push('配置缺少匹配规则（matches），补全后再启用')
    }

    scripts.push({ name, config: resolved.config, code, ...(notes.length ? { notes } : {}) })
  }

  return { scripts, ignored }
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
 * 内容指纹（重复导入提示用）：源码整体 SHA-256。
 * 只提示不拦截——重复导入 = 独立副本是合理场景。
 */
export async function sourceFingerprint(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', strToU8(code))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
