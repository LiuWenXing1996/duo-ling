// 用户脚本 metadata 块解析（`// ==UserScript==` … `// ==/UserScript==`）。
//
// 定位：**标准油猴脚本的入口**。解析结果由写入口（保存 / 导入 / script_apply）归一化进
// ScriptConfig —— 之后 config 是唯一运行期事实源，**不反向回写源码**（2026-09-20 拍板）。
//
// 两条纪律（与项目既有哲学一致）：
//   ① **尽量导入**：任何字段缺失 / 非法都不阻断，产出 `notes` 交调用方提示（对齐 zip 导入的
//      「只拦原则项、坏脚本照样装、保存恒成功」）；
//   ② **单一归一化路径**：本模块产出的 ScriptConfig 与 zip 导入共用同一形状与默认值
//      （`resolveConfigFromSource` 是唯一归一化函数），不新写第二套。
//
// 取值规则（对齐 Tampermonkey）：
//   · 只认**第一个** metadata 块；
//   · 单值键（@name / @namespace / @version / @description / @author / @icon / @run-at）
//     **无后缀写法优先、同级首次胜**：`@name` 恒胜过 `@name:zh-CN`（本地化只作兜底），
//     重复的无后缀键取第一个（TM 同款）；
//   · 多值键（@match / @include / @exclude / @grant / @require / @resource / @connect）按出现顺序累积。
import type { ScriptConfig, ScriptResourceDecl } from './types'
import { isValidMatchPattern } from './project-store'
import { parseMatchPattern } from './match-pattern'

export type { ScriptResourceDecl }

/** 一个 metadata 块的解析产物（原样值，未与 config 归一化） */
export interface ParsedMetadata {
  /** 原始块文本（含首尾标记行）—— GM_info.scriptMetaStr 直接用 */
  raw: string
  name?: string
  namespace?: string
  version?: string
  description?: string
  author?: string
  icon?: string
  /** `@match` 原值（未校验、未去重） */
  matches: string[]
  /** `@include` 原值（glob / 正则形态未转换） */
  includes: string[]
  /** `@exclude` 原值 */
  excludes: string[]
  /** `@run-at` 原值，如 `document-start` */
  runAtRaw?: string
  /** 出现 `@noframes` 即 true（无值键） */
  noframes: boolean
  /** `@grant` 全部值（保序去重，含 `none`） */
  grants: string[]
  /** `@require` URL（保序，重复保留——脚本可依赖同址多次注入的顺序） */
  requires: string[]
  /** `@resource name url`（保序） */
  resources: ScriptResourceDecl[]
  /** `@connect` 全部值（本扩展 fetch 无需白名单，仅记录供展示） */
  connects: string[]
}

/** 把一行注释剥成裸内容：去空白 → 去 `//` → 再 trim。兼容 `//==UserScript==` 与 `// ==UserScript==` */
function bareLine(line: string): string {
  return line.trim().replace(/^\/\/\s?/, '').trim()
}

const START_MARK = '==UserScript=='
const END_MARK = '==/UserScript=='

/** 键行：`@key value` / `@key:locale value`（键名限定为字母开头 + 词/连字符） */
const KEY_LINE_RE = /^@([A-Za-z][A-Za-z0-9-]*)(?::([A-Za-z0-9-]+))?\s*(.*)$/

/** 正则形态的 @include / @exclude（TM 支持 `/re/flags`），本扩展不支持 */
const REGEX_FORM_RE = /^\/.*\/[gimsuy]*$/

/** 单值键：首次出现者胜（本地化后缀不参与判定） */
const SINGLE_KEYS = new Set(['name', 'namespace', 'version', 'description', 'author', 'icon', 'run-at'])

/**
 * 解析源码里的第一个 metadata 块。
 *
 * 找不到块返回 null（无 metadata 的脚本是正常形态，调用方沿用现有 config）。
 * 块的**内容**再不合法也不抛错——非法项由 `applyMetadataToConfig` 转为 notes。
 */
export function parseUserScriptMetadata(code: string): ParsedMetadata | null {
  const lines = code.split(/\r?\n/)
  let start = -1
  let end = -1
  for (let i = 0; i < lines.length; i++) {
    const bare = bareLine(lines[i]!)
    if (start < 0) {
      if (bare === START_MARK) start = i
      continue
    }
    if (bare === END_MARK) {
      end = i
      break
    }
  }
  if (start < 0 || end < 0) return null

  const raw = lines.slice(start, end + 1).join('\n')
  // 单值键的两级占位：无后缀写法（`@name`）恒胜过本地化写法（`@name:zh-CN`）；
  // 同级内首次出现者胜。顺序无关 —— 本地化只是展示糖，不该抢 GM_info.script.name 的身份。
  const seenPlain = new Set<string>()
  const seenLocalized = new Set<string>()
  const out: ParsedMetadata = {
    raw,
    matches: [],
    includes: [],
    excludes: [],
    noframes: false,
    grants: [],
    requires: [],
    resources: [],
    connects: [],
  }
  for (let i = start + 1; i < end; i++) {
    const bare = bareLine(lines[i]!)
    if (!bare.startsWith('@')) continue
    const m = KEY_LINE_RE.exec(bare)
    if (!m) continue
    const key = m[1]!.toLowerCase()
    const value = m[3]!.trim()

    if (key === 'noframes') {
      out.noframes = true
      continue
    }
    if (SINGLE_KEYS.has(key)) {
      if (!value) continue // 空值不占位
      if (m[2] === undefined) {
        if (seenPlain.has(key)) continue
        seenPlain.add(key)
      } else {
        if (seenPlain.has(key) || seenLocalized.has(key)) continue
        seenLocalized.add(key)
      }
      switch (key) {
        case 'name':
          out.name = value
          break
        case 'namespace':
          out.namespace = value
          break
        case 'version':
          out.version = value
          break
        case 'description':
          out.description = value
          break
        case 'author':
          out.author = value
          break
        case 'icon':
          out.icon = value
          break
        case 'run-at':
          out.runAtRaw = value
          break
      }
      continue
    }
    if (!value) continue
    switch (key) {
      case 'match':
        out.matches.push(value)
        break
      case 'include':
        out.includes.push(value)
        break
      case 'exclude':
        out.excludes.push(value)
        break
      case 'grant':
        if (!out.grants.includes(value)) out.grants.push(value)
        break
      case 'require':
        out.requires.push(value)
        break
      case 'resource': {
        // `@resource name url`：名字与 URL 用空白分隔
        const sp = value.search(/\s/)
        if (sp > 0) {
          out.resources.push({ name: value.slice(0, sp), url: value.slice(sp + 1).trim() })
        }
        break
      }
      case 'connect':
        out.connects.push(value)
        break
    }
  }
  return out
}

/** 归一化产物：配置 + 可覆盖的脚本名 + 需要告知用户的提示 */
export interface MetadataApplyResult {
  config: ScriptConfig
  /** metadata 里声明的 `@name`（有则调用方用它覆盖脚本名） */
  name?: string
  /** 提示（字段兜底 / 已覆盖 / 已丢弃 / 已近似转换），空数组 = 无需提示 */
  notes: string[]
}

/** `@run-at` 原值 → ScriptConfig.runAt；不认识返回 null（不猜） */
function mapRunAt(raw: string | undefined): ScriptConfig['runAt'] | null {
  if (!raw) return null
  const v = raw.trim().toLowerCase().replace(/_/g, '-')
  if (v === 'document-start') return 'document_start'
  if (v === 'document-end') return 'document_end'
  if (v === 'document-idle') return 'document_idle'
  return null
}

type Converted = { kind: 'match'; value: string } | { kind: 'glob'; value: string } | { kind: 'drop'; reason: string }

/** Chrome 认可的 host 段：`*`（任意）、`*.example.com`（域 + 子域）或裸主机名；**不含端口** */
const CHROME_HOST_RE = /^(?:\*|(?:\*\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)$/

/**
 * 是否是可安全交给 `chrome.userScripts.register` 的 match pattern。
 *
 * 比项目自己的 `isValidMatchPattern` **更严**：`MATCH_PATTERN_RE` 的 host 段是 `[^/*]*`，两个宽松点
 * 都会让 Chrome 拒收：① 可为空 → `*:///foo/*` 被判合法；② 允许冒号 → `https://example.com:8443/*`
 * （match pattern 语法不表达端口）被判合法。解析器不允许产出这类 pattern —— 否则错误会一路拖到
 * 注册期才以 Chrome 的英文异常冒出（对齐 project-store 文件头「非法值在导入 / 启用当场拦下」的意图）。
 *
 * `file:` / `urn:` 的 host 段天然为空，属合法例外（见 project-store 的语法注释）。
 */
function isChromeSafeMatch(pattern: string): boolean {
  if (!isValidMatchPattern(pattern)) return false
  const parsed = parseMatchPattern(pattern)
  if (!parsed) return false
  if (parsed.host === '') return parsed.scheme === 'file' || parsed.scheme === 'urn'
  return CHROME_HOST_RE.test(parsed.host)
}

/**
 * `@include` / `@exclude` 的一条 → match pattern / glob / 丢弃。
 *
 * 转换阶梯（**顺序不可调**，每步都靠 `isChromeSafeMatch` 兜底，绝不产出 Chrome 会拒的 pattern）：
 *   1. `*` / `<all_urls>` → 全域 match；
 *   2. 本身是 Chrome 安全 match pattern → 直通（`https://example.com/foo/*` 走这条）；
 *   3. **纯路径 / 正则分流必须在补 scheme 之前**：`/foo/*` 若先补成 `*:///foo/*`，空 host 会被
 *      上面的校验器放行但 Chrome 拒绝（见 `isChromeSafeMatch`）。故此处先判 `/` 开头：
 *      正则形态（`/^https:\/\//`）→ 丢弃；纯路径 → 降为 glob（`*` scheme + `*` host + 原路径），
 *      **调用方须同时把 matches 放宽为全域 pattern**（见 applyMetadataToConfig 的说明）；
 *   4. 补 `*://` 后为 Chrome 安全 pattern → 直通（`*.example.com/*` 这类省略 scheme 的写法）；
 *   5. 其余 → 丢弃并说明。
 */
function convertPattern(raw: string): Converted {
  const v = raw.trim()
  if (v === '*' || v === '<all_urls>') return { kind: 'match', value: '*://*/*' }
  if (isChromeSafeMatch(v)) return { kind: 'match', value: v }
  // 纯路径（`/foo/*`、`/^https:\/\//`）必须在补 `*://` 之前分流：项目自己的 MATCH_PATTERN_RE
  // 会接受空 host 的 `*:///foo/*`（Chrome 实际拒绝），先补就会产出注册必失败的 pattern。
  if (v.startsWith('/')) {
    if (REGEX_FORM_RE.test(v)) return { kind: 'drop', reason: `正则形式的写法暂不支持：${v}` }
    return { kind: 'glob', value: `*://*${v}` }
  }
  if (isChromeSafeMatch(`*://${v}`)) return { kind: 'match', value: `*://${v}` }
  return { kind: 'drop', reason: `无法转换为匹配规则：${v}` }
}

/** 保序去重 */
function dedupe(list: string[]): string[] {
  return [...new Set(list)]
}

/**
 * 把解析产物归一化进 ScriptConfig。
 *
 * **覆盖规则（「metadata 为准」的精确化）**：逐字段判定，metadata **声明了就采用 metadata、
 * 没声明就沿用 fallback**。故 UI 里手改的配置只在源码没声明对应键时保留 —— 覆盖发生时会写进 notes。
 *
 * **`@include` 纯路径形态的安全含义**（须知情）：`@include /foo/*` 在油猴语义下是「任意站点的
 * 该路径」，注入面本来就是全部站点，故这里如实把 matches 放宽为**全域 pattern**（`*` scheme +
 * `*` host + 任意 path），再用 includeGlobs 收窄。
 * 连带效应是 **cookie 访问范围随之放开**（门的不变量是「cookie ⊆ 注入面」，见 cookie-gate.ts）
 * —— 不是门的漏洞，而是脚本自己声明了全域。该情形会**写入 notes**，不静默。
 */
export function applyMetadataToConfig(
  parsed: ParsedMetadata,
  fallback: ScriptConfig,
): MetadataApplyResult {
  const notes: string[] = []
  const matches: string[] = []
  const excludeMatches: string[] = []
  const includeGlobs: string[] = []
  const excludeGlobs: string[] = []
  let widenAll = false

  for (const raw of parsed.matches) {
    // 这里必须用 isChromeSafeMatch 而非 isValidMatchPattern：后者接受空 host / 带端口 host，
    // 而 @match 是直接进 chrome.userScripts.register 的字段，产出的值 Chrome 必须认。
    if (isChromeSafeMatch(raw)) matches.push(raw)
    else notes.push(`@match 不合法，已忽略：${raw}`)
  }
  for (const raw of parsed.includes) {
    const c = convertPattern(raw)
    if (c.kind === 'match') matches.push(c.value)
    else if (c.kind === 'glob') {
      includeGlobs.push(c.value)
      widenAll = true
      notes.push(
        `@include「${raw}」未指定站点，已按「任意站点」处理：注入面放宽为全部站点，cookie 访问范围随之放开`,
      )
    } else notes.push(`@include ${c.reason}`)
  }
  for (const raw of parsed.excludes) {
    const c = convertPattern(raw)
    if (c.kind === 'match') excludeMatches.push(c.value)
    else if (c.kind === 'glob') excludeGlobs.push(c.value)
    else notes.push(`@exclude ${c.reason}`)
  }
  if (widenAll) matches.push('*://*/*')

  const declaredMatches = matches.length > 0
  const declaredRunAt = mapRunAt(parsed.runAtRaw)
  if (parsed.runAtRaw && !declaredRunAt) notes.push(`@run-at 取值不认识，已沿用原配置：${parsed.runAtRaw}`)

  const config: ScriptConfig = {
    // 未声明匹配规则时沿用 fallback（导入路径的 fallback 是空数组 → 落「不匹配任何页面」，与 project-write.ts 的写入口归一化一致）
    matches: declaredMatches ? dedupe(matches) : (fallback.matches ?? []),
    allFrames: parsed.noframes ? false : (fallback.allFrames ?? true),
    runAt: declaredRunAt ?? fallback.runAt ?? 'document_end',
  }

  const exclM = dedupe([...excludeMatches, ...(declaredMatches ? [] : (fallback.excludeMatches ?? []))])
  if (exclM.length) config.excludeMatches = exclM
  const exclG = dedupe([...excludeGlobs, ...(declaredMatches ? [] : (fallback.excludeGlobs ?? []))])
  if (exclG.length) config.excludeGlobs = exclG
  const inclG = dedupe([...includeGlobs, ...(declaredMatches ? [] : (fallback.includeGlobs ?? []))])
  if (inclG.length) config.includeGlobs = inclG

  // 注入期配置：metadata 声明即采用，未声明沿用 fallback
  const grant = parsed.grants.slice()
  if (grant.length) config.grant = grant
  else if (fallback.grant?.length) config.grant = fallback.grant
  if (parsed.requires.length) config.requires = parsed.requires.slice()
  else if (fallback.requires?.length) config.requires = fallback.requires
  if (parsed.resources.length) config.resources = parsed.resources.slice()
  else if (fallback.resources?.length) config.resources = fallback.resources
  if (parsed.namespace) config.namespace = parsed.namespace
  if (parsed.version) config.version = parsed.version
  if (parsed.description) config.description = parsed.description
  if (parsed.author) config.author = parsed.author
  if (parsed.icon) config.icon = parsed.icon

  return { config, ...(parsed.name ? { name: parsed.name } : {}), notes }
}

/**
 * 写入口用的便捷封装：无 metadata 块时原样返回 fallback（零 notes）。
 * 有块则解析 + 归一化，并把解析器自己的提示合并进来。
 */
export function resolveConfigFromSource(
  code: string,
  fallback: ScriptConfig,
): MetadataApplyResult {
  const parsed = parseUserScriptMetadata(code)
  if (!parsed) return { config: fallback, notes: [] }
  return applyMetadataToConfig(parsed, fallback)
}
