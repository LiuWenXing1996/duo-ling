// match pattern ↔ url 判定（**运行期**），GM_cookie 域名门的纯逻辑部分（门本体见 cookie-gate.ts）。
//
// 与 project-store.isValidMatchPattern 的分工：那里是「注册前校验 pattern 合法性」，
// 这里是「运行期判某条 url 是否落在 pattern 范围内」。两者语法认知同源，职责不同，故不复用函数。
//
// **关键语义（2026-09-19 经评审确认）：只比 scheme + host，pattern 的 path 段一律当 `/*` 处理。**
// 理由：cookie 是 host 级作用域，不与路径相关 —— 只注入 https://example.com/foo/* 的脚本，
// 若不忽略 path 就连站点自己的 cookie（path 通常是 /）都读不到，违反 cookie 的天然语义。
// 放宽的只是「同一 host 内的路径收窄」，跨 host 的边界一点没松（安全不变量）。
//
// 不做的事：不解析端口（match pattern 语法本身不支持端口，url 侧取 hostname 即天然丢端口）。

/** 域名门用到的配置子集（ScriptConfig 的相关字段） */
export interface CookieScope {
  matches?: string[]
  excludeMatches?: string[]
}

/** 解析结果：scheme 取 pattern 原字面量（'*' 表示 http/https 通配） */
export interface ParsedMatchPattern {
  scheme: string
  /** '*' = 任意 host；'*.example.com' = 域本身 + 全部子域；其余为字面量 */
  host: string
}

// 与 project-store.MATCH_PATTERN_RE 同一套语法，区别是**捕获** scheme / host 两段、丢掉 path。
const MATCH_PATTERN_RE = /^(\*|https?|file|ftp|urn):\/\/(\*|(?:\*\.)?[^/*]*)(?:\/.*)$/

/** 解析 match pattern；`<all_urls>` 特例等价于任意 scheme + 任意 host。非法返回 null */
export function parseMatchPattern(pattern: string): ParsedMatchPattern | null {
  if (pattern === '<all_urls>') return { scheme: '*', host: '*' }
  const m = MATCH_PATTERN_RE.exec(pattern)
  if (!m) return null
  return { scheme: m[1]!, host: m[2]!.toLowerCase() }
}

/** url 的 scheme + host（仅 http/https 参与匹配，其余如 chrome-extension / data 一律不匹配） */
function schemeAndHostOf(url: string): { scheme: string; host: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const scheme = parsed.protocol.replace(/:$/, '')
  if (scheme !== 'http' && scheme !== 'https') return null
  return { scheme, host: parsed.hostname.toLowerCase() }
}

/** pattern 的 scheme 是否覆盖 url 的 scheme（`*` 覆盖 http 与 https） */
function schemeCovers(patternScheme: string, urlScheme: string): boolean {
  if (patternScheme === '*') return urlScheme === 'http' || urlScheme === 'https'
  return patternScheme === urlScheme
}

/** pattern 的 host 是否覆盖 url 的 host（`*.example.com` 含 example.com 本身） */
function hostCovers(patternHost: string, urlHost: string): boolean {
  if (patternHost === '*') return true
  if (patternHost.startsWith('*.')) {
    const apex = patternHost.slice(2)
    return urlHost === apex || urlHost.endsWith(`.${apex}`)
  }
  return urlHost === patternHost
}

/**
 * 单条 pattern 是否覆盖该 url（**只比 scheme + host**，path 见文件头）。
 * url 非法 / 非 http(s) / pattern 非法 → false。
 */
export function matchPatternCoversUrl(pattern: string, url: string): boolean {
  const parsed = parseMatchPattern(pattern)
  if (!parsed) return false
  const target = schemeAndHostOf(url)
  if (!target) return false
  return schemeCovers(parsed.scheme, target.scheme) && hostCovers(parsed.host, target.host)
}

/**
 * url 是否落在该脚本的 cookie 作用域内：命中 matches 任一条，且不命中 excludeMatches 任一条。
 * matches 为空 / 缺省 → 恒 false（没有注入面的脚本没有 cookie 访问权）。
 */
export function urlInCookieScope(scope: CookieScope, url: string): boolean {
  const matches = scope.matches ?? []
  if (!matches.length) return false
  if (!matches.some((p) => matchPatternCoversUrl(p, url))) return false
  return !(scope.excludeMatches ?? []).some((p) => matchPatternCoversUrl(p, url))
}
