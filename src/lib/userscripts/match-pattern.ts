// @match 规则（Chrome match pattern）的 URL 匹配器（提案② runtime-feedback-loop.md「静态匹配口径」）。
//
// 为什么自己写：脚本页面的匹配目前全靠 chrome.userScripts 原生做，扩展侧从来没有
// 匹配器；浮窗的「本页脚本」判定（enabled + matches 命中页面 URL）需要在 SW 侧
// 用与原生一致的语义自行判定，否则浮窗会与脚本的真实注入范围不一致。
//
// 语法（developer.chrome.com/docs/extensions/develop/concepts/match-patterns）：
//   <url-pattern> := <scheme>://<host><path> | <all_urls>
//   scheme        := '*' | 'http' | 'https' | 'file' | 'ftp'
//                  （'*' = http 或 https；'urn'/'ws' 等本期不涉及，按不支持处理）
//   host          := '*' | '*.' <非空域名段> | <非空域名段>（file 方案允许空 host）
//   path          := '/' 开头的任意串，可含 '*' 通配
//
// 已知简化（对本用途足够，见各处注释）：端口并入 host 精确比对；IDN 按原样字符比对。

/** 编译一条 match pattern 为 RegExp；非法 pattern 返回 null（调用方跳过该条，不 throw——
 * 一条手写坏规则不应让整个浮窗判定挂掉。原生 register 时本来也会校验，这里兜底） */
export function matchPatternToRegExp(pattern: string): RegExp | null {
  if (pattern === '<all_urls>') {
    return /^(?:https?|file|ftp):\/\//i
  }
  const m = /^(\*|https?|file|ftp):\/\/(\*|(?:\*\.)?[^/*]+|)\/(.*)$/i.exec(pattern)
  if (!m) return null
  const [, schemeRaw, hostRaw, pathRaw] = m
  const scheme = schemeRaw.toLowerCase() === '*' ? 'https?' : schemeRaw.toLowerCase()
  let host: string
  if (hostRaw === '*') {
    // '*' 任意 host 仅对 http(s) 合法（file 没有 host 概念）
    if (scheme === 'file' || scheme === 'ftp') return null
    host = '[^/]*'
  } else if (hostRaw.startsWith('*.')) {
    // '*.example.com' = example.com 本身 + 任意子域
    const base = escapeRegExp(hostRaw.slice(2))
    if (!base) return null
    host = `(?:${base}|[^/]*\\.${base})`
  } else if (hostRaw === '' && (scheme === 'file' || scheme === 'ftp')) {
    host = ''
  } else if (hostRaw === '' || /[*?]/.test(hostRaw)) {
    // 空 host 只允许 file/ftp；其余 host 不允许通配（与原生一致）
    return null
  } else {
    host = escapeRegExp(hostRaw)
  }
  const pathRe = escapeRegExp(pathRaw).replace(/\\\*/g, '.*')
  return new RegExp(`^${scheme}://${host}/${pathRe}$`, 'i')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** URL 是否命中一条 match pattern（解析失败 / 非 http(s|file|ftp) URL 返回 false） */
export function urlMatchesPattern(url: string, pattern: string): boolean {
  const re = matchPatternToRegExp(pattern)
  if (!re) return false
  return re.test(url)
}

/** URL 是否命中任一 pattern（url 非法直接 false） */
export function matchesAnyPattern(url: string, patterns: readonly string[]): boolean {
  if (!patterns.length) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (!/^(https?|file|ftp):$/i.test(parsed.protocol)) return false
  return patterns.some((p) => urlMatchesPattern(url, p))
}
