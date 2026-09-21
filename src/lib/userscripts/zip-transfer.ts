// 用户脚本 zip 导入导出的纯函数编解码层。
//
// 编码在 UI 导出侧（工作台标签页，userscript:getProject 只读命令取数后打包），
// 解码在 offscreen 导入侧（单写方，state:import → project-write.importScriptsZip），
// 两侧共用本模块——故这里**不得 import 任何 chrome API**（offscreen 与单测的 node 环境
// 都要能跑）。
//
// 安全：zip slip 防护在本模块的解码层做拦截（.. 段 / 绝对路径 / 盘符 / 反斜杠）。
//
// 解码层**只拦原则项**——
// 缺 script.js 源码文件（无源码就构造不出记录）。其余一律放行：源码里的 `// ==UserScript==`
// 块声明了配置就采用、没有就按默认配置导入（缺 matches 提示用户补全，不阻断）。
// 故导入侧的「校验」不再是拦截，而是**尽量修复 + 报告**。
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { SCRIPT_FILE, defaultConfig } from './types'
import type { ScriptConfig } from './types'
import { resolveConfigFromSource } from './metadata'

/** zip schema 版本（历史字段；**解码侧不据此拦截**——开发期无版本规范，见文件头） */
export const ZIP_SCHEMA_VERSION = 2

/** zip 目录名长度上限（超长截断，防极端名称撑爆解压路径） */
const DIR_NAME_MAX = 64

/** 单脚本的编码入参（zip 内只有 script.js，name 仅用于目录名，配置由源码派生） */
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

/** 解码时被跳过的顶层目录——**只剩原则项**（缺源码文件） */
export interface ParsedSkip {
  /** zip 顶层目录名（≠真名，仅排障展示） */
  dirName: string
  reason: string
}

/** 解码时未导入的文件（顶层散文件 / 非脚本条目 / 路径不安全被过滤）——仅展示，不阻断脚本导入 */
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
 * 把若干脚本打成 zip。单文件形态：每脚本一个平级目录，目录内**只有 script.js**。
 * 目录名 = 脚本名安全化，重名加 -2 后缀。配置不进 zip（导入时从源码派生）。
 */
export function buildScriptZip(scripts: ZipScriptPayload[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  const usedDirs = new Set<string>()
  for (const s of scripts) {
    const dir = uniqueDirName(sanitizeDirName(s.name), usedDirs)
    entries[`${dir}/${SCRIPT_FILE}`] = strToU8(s.code)
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

/** zip 内相对路径安全性（zip slip 第一道闸）：非空、不以 / 开头、不含反斜杠（Windows 路径混入信号）、
 *  不含盘符前缀、每段非空且不是 . / .. 段。 */
function isSafeRelPath(p: string): boolean {
  return (
    !!p &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    !/^[a-zA-Z]:/.test(p) &&
    p.split('/').every((seg) => !!seg && seg !== '.' && seg !== '..')
  )
}

/**
 * 解析脚本 zip（**只拦原则项，尽量导入**，见文件头）：
 *  · 顶层散条目与脚本目录内的非脚本条目（data/ 等）→ 未导入，进 ignored 报告；
 *  · 路径不安全的**文件**（zip slip 特征）→ 只过滤该文件（进 ignored 报告），脚本其余照常导入；
 *  · 配置由源码里的 `// ==UserScript==` 块派生；缺块则按默认配置导入，缺 matches 提示用户补全；
 *  · 目录名 ≠ 真名；name 缺失时以目录名兜底；
 *  · **唯一跳过**：缺 script.js（无源码就构造不出记录）。
 * 本函数不做语法校验——坏脚本照样导入（保存即注入的语义），运行期报错走错误日志。
 */
export function parseScriptsZip(bytes: Uint8Array): ScriptsZipParse {
  const unzipped = unzipSync(bytes)
  const scripts: ParsedScript[] = []
  const skipped: ParsedSkip[] = []
  // 未导入的文件（仅展示，不计入成功/失败）：顶层散文件 + 路径不安全被过滤的文件 +
  // 脚本目录内的非脚本条目。目录占位条目（path 以 / 结尾）不计入——它只是机械目录项，
  // 且与已导入的脚本目录重名会误导。
  const ignored: ParsedIgnored[] = []

  // 按顶层目录分组：path 去掉首个段后按目录归堆（目录占位条目与顶层散文件先分流）；
  // 路径不安全的条目（zip slip 特征）在此过滤——只丢该文件，不整目录拒绝
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
    if (!isSafeRelPath(top) || !isSafeRelPath(rest)) {
      ignored.push({ path, reason: '路径不安全（含 .. 段 / 绝对路径 / 反斜杠 / 盘符），已过滤' })
      continue
    }
    if (!groups.has(top)) groups.set(top, new Map())
    groups.get(top)!.set(rest, content)
  }

  const skip = (dirName: string, reason: string) => skipped.push({ dirName, reason })

  for (const [top, filesByDir] of groups) {
    // —— 原则项：缺源码文件就构造不出记录 ——
    const codeRaw = filesByDir.get(SCRIPT_FILE)
    if (!codeRaw) {
      skip(top, `缺少 ${SCRIPT_FILE} 源码文件`)
      continue
    }
    const code = strFromU8(codeRaw)
    // 其余条目（data/ 等历史遗留或杂项）未导入，仅提示
    for (const rest of filesByDir.keys()) {
      if (rest !== SCRIPT_FILE) {
        ignored.push({
          path: `${top}/${rest}`,
          reason: '脚本目录内的非脚本条目（如 data/ 遗留），未导入',
        })
      }
    }

    // 配置完全由源码里的 // ==UserScript== 块派生（单一归一化路径），无块则按默认配置。
    const resolved = resolveConfigFromSource(code, defaultConfig([]))
    let name = resolved.name?.trim()
    const notes: string[] = [...resolved.notes]
    if (!name) {
      name = top
      notes.push(`缺少脚本名（name），已用目录名「${top}」`)
    }
    if (!resolved.config.matches.length) {
      notes.push('配置缺少匹配规则（matches），补全后再启用')
    }

    scripts.push({ name, config: resolved.config, code, ...(notes.length ? { notes } : {}) })
  }

  return { scripts, skipped, ignored }
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
