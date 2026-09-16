// 用户脚本 zip 导入导出的纯函数编解码层（docs/userscript-zip-transfer.md §3/§5.2）。
//
// 编码在 UI 导出侧（工作台标签页，userscript:getProject 只读命令取数后打包），
// 解码在 offscreen 导入侧（单写方，state:import → project-write.importScriptsZip），
// 两侧共用本模块——故这里**不得 import 任何 chrome API**（offscreen 与单测的 node 环境
// 都要能跑）。
//
// 安全：zip slip 防护在本模块的解码层做第一道拦截（.. 段 / 绝对路径 / 盘符 / 反斜杠），
// offscreen 落盘前的 validateFiles（project-store）是第二道闸——外部数据两道闸。
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ScriptConfig } from './types'

/** zip schema 版本（project.json.v；导入侧 v > 本值一律跳过并提示升级） */
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

/** 解码出的一个待导入脚本 */
export type ParsedScript = ZipScriptPayload

/** 解码时被跳过的顶层目录（逐脚本独立容错，定稿 §5.7） */
export interface ParsedSkip {
  /** zip 顶层目录名（≠真名，仅排障展示） */
  dirName: string
  reason: string
}

export interface ScriptsZipParse {
  scripts: ParsedScript[]
  skipped: ParsedSkip[]
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
 * 解析脚本 zip（定稿 §5.2 解析安全）：
 *  · 顶层散条目与 files/ 之外的条目（含 data/ 预留位）忽略不报错；
 *  · 目录名 ≠ 真名，一律以 project.json.name 为准；
 *  · v 缺失 / 非法 / files 路径含 zip slip 特征 → 该脚本跳过带原因；
 *  · v 大于本实现 → 跳过并提示「由新版哆灵导出，请先升级扩展」。
 * 本函数不做构建与落盘校验（validateFiles / validateMatchPatterns 在 offscreen 写侧把关）。
 */
export function parseScriptsZip(bytes: Uint8Array): ScriptsZipParse {
  const unzipped = unzipSync(bytes)
  const scripts: ParsedScript[] = []
  const skipped: ParsedSkip[] = []

  // 按顶层目录分组：path 去掉首个段后按目录归堆（目录占位条目与顶层散文件忽略）
  const groups = new Map<string, Map<string, Uint8Array>>()
  for (const [path, content] of Object.entries(unzipped)) {
    if (path.endsWith('/')) continue
    const slash = path.indexOf('/')
    if (slash <= 0) continue
    const top = path.slice(0, slash)
    const rest = path.slice(slash + 1)
    if (!groups.has(top)) groups.set(top, new Map())
    groups.get(top)!.set(rest, content)
  }

  const skip = (dirName: string, reason: string) => skipped.push({ dirName, reason })

  for (const [top, filesByDir] of groups) {
    const manifestRaw = filesByDir.get('project.json')
    if (!manifestRaw) {
      skip(top, '缺少 project.json')
      continue
    }
    let manifest: ZipManifest
    try {
      manifest = JSON.parse(strFromU8(manifestRaw)) as ZipManifest
    } catch {
      skip(top, 'project.json 不是合法 JSON')
      continue
    }
    if (typeof manifest.v !== 'number') {
      skip(top, 'project.json 缺少 schema 版本（v）')
      continue
    }
    if (manifest.v > ZIP_SCHEMA_VERSION) {
      skip(top, '由新版哆灵导出，请先升级扩展')
      continue
    }
    if (manifest.v !== ZIP_SCHEMA_VERSION) {
      skip(top, `不支持的 schema 版本：v=${manifest.v}`)
      continue
    }
    if (!manifest.name || typeof manifest.name !== 'string') {
      skip(top, 'project.json 缺少脚本名（name）')
      continue
    }
    if (!manifest.entry || typeof manifest.entry !== 'string') {
      skip(top, 'project.json 缺少入口文件（entry）')
      continue
    }
    const cfg = manifest.config
    if (
      !cfg ||
      typeof cfg !== 'object' ||
      !Array.isArray(cfg.matches) ||
      !cfg.matches.length ||
      !cfg.matches.every((m: unknown) => typeof m === 'string')
    ) {
      skip(top, 'project.json 配置非法（matches 必须是非空字符串数组）')
      continue
    }

    // 只认 files/ 前缀；data/ 等其余条目忽略（备份语义预留位，v1 恒空）
    const files: Record<string, string> = {}
    let hasBadPath = false
    for (const [rest, content] of filesByDir) {
      if (!rest.startsWith('files/')) continue
      const rel = rest.slice('files/'.length)
      if (!rel || rel.endsWith('/')) continue
      if (!isSafeRelPath(rel)) {
        hasBadPath = true
        break
      }
      files[rel] = strFromU8(content)
    }
    if (hasBadPath) {
      skip(top, 'files 含非法路径（zip slip 防护：.. 段 / 绝对路径）')
      continue
    }
    if (!Object.keys(files).length) {
      skip(top, 'files 为空或缺失')
      continue
    }
    if (!(manifest.entry in files)) {
      skip(top, `入口文件在 files 中不存在：${manifest.entry}`)
      continue
    }
    scripts.push({ name: manifest.name, config: cfg, entry: manifest.entry, files })
  }

  return { scripts, skipped }
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
