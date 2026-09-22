// 「当前标签页是不是能挂浮层的普通网页」——浮层设置相关 UI（popup、工作台设置页）共用的判据。
//
// 为什么只能按 **scheme** 判，不能直接从 tab.url 取 hostname：浏览器内部页（`chrome://`）、
// 扩展页（`chrome-extension://`）上扩展根本读不到 url —— manifest 没有 `tabs` 权限，
// 而 `<all_urls>` 不含这两个 scheme（2026-09-21 无头实测：`chrome://version` 与扩展自身页的
// `tab.url` 都是 `undefined`，`tabs.query` 其他字段正常）。更要紧的是扩展页：
// `chrome-extension://<id>/workbench.html` 的 hostname 就是**扩展自己的 id**，谁直接取
// hostname 谁就会把这串 id 当成一个「网站」显示，还能顺手写进站点禁用集合。
//
// 本判据**覆盖不了**的两类，别指望它兜住：
//   · 本地文件页 `file://`：未开「允许访问文件网址」时读不到 url，读得到时 hostname 为空，
//     两种情形都返回空串 —— 而它**开了那个开关后是可注入的**，故调用方的提示文案要把它
//     一起说到（见 PopupPanel.vue 的「不能显示浮层」提示）。
//   · 应用商店（`https://chromewebstore.google.com/...`）：scheme 上就是普通网页，本函数照常
//     给 hostname。拦它的是 Chrome 的注入策略，从 url 里判不出来，由页面内的降级提示负责。
//
// 判据只此一处：调用方不要自己写 `new URL(url).hostname`。
//
// 本模块另含「用户输入 ↔ 存储条目」三件转换：`normalizeSitePattern`（输入 → match pattern）、
// `sitePatternLabel`（条目 → 展示用域名）、`splitSiteInputs`（粘贴文本 → 逐条）。
// **条目的匹配判定不在这里**，归 lib/match-pattern.ts。

import { parseMatchPattern } from '@/lib/match-pattern'

/** 普通网页（http / https）的 hostname；内部页 / 扩展页（含本扩展自己的页）返回空串 */
export function webHostname(url: string | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : ''
  } catch {
    return ''
  }
}

/**
 * 用户输入的一条站点 → 存储用的 match pattern；认不出来返回 null（调用方据此报「无效」）。
 *
 * 宽容的地方：整条 URL（`https://www.a.com/x?y`）与带路径的裸域名（`a.com/foo`）都收；
 * 大小写、前后空白一律规范化。**非 http(s) 的 URL 一律拒**（`chrome-extension://…` 之类不是站点）。
 *
 * 语义（与 Chrome「网站设置」的 `[*.]example.com` 默认一致）：**纯域名默认连子域一起关** ——
 * `example.com` → `*://*.example.com/*`。想要「只关本域不含子域」不提供：关浮层场景下没有意义，
 * 只会让输入多一种要学的写法。单标签 host（localhost）与 IPv4 字面量不带 `*.`。
 */
export function normalizeSitePattern(raw: string): string | null {
  let s = raw.trim().toLowerCase()
  if (!s) return null
  if (s.includes('://')) {
    try {
      const u = new URL(s)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
      s = u.hostname
    } catch {
      return null
    }
  } else {
    s = s.split('/')[0]! // 容忍 `a.com/foo` 这种没有 scheme 的粘贴
  }
  const explicitWildcard = s.startsWith('*.')
  const host = explicitWildcard ? s.slice(2) : s
  if (!isSiteHost(host)) return null
  const withSubdomains = (explicitWildcard || host.includes('.')) && !isIPv4(host)
  return withSubdomains ? `*://*.${host}/*` : `*://${host}/*`
}

/** IPv4 字面量没有子域可言，不该带 `*.` 前缀 */
function isIPv4(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
}

/** 能不能当一个站点条目：localhost 或至少两段标签，且每段是合法的域名片段（IPv4 天然满足） */
function isSiteHost(host: string): boolean {
  if (host === 'localhost') return true
  if (!host.includes('.')) return false
  const label = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'
  return new RegExp(`^${label}(?:\\.${label})+$`).test(host)
}

/**
 * 存储条目 → 展示用域名：`*://*.example.com/*` → `example.com`。
 *
 * 历史条目（早期直接存裸 hostname，如 `www.example.com`）不是合法 pattern，原样显示 ——
 * 它们的判定语义是精确匹配，见 float-panel-store 的条目判定。
 */
export function sitePatternLabel(entry: string): string {
  const parsed = parseMatchPattern(entry)
  if (!parsed) return entry
  return parsed.host.startsWith('*.') ? parsed.host.slice(2) : parsed.host
}

/**
 * 用户粘贴的多条输入 → 逐条待规范化的原始串。
 * 一行一条；也容忍逗号 / 中英文分号 / 空格分隔 —— 从别处整段粘一串域名是最常见的用法。
 */
export function splitSiteInputs(text: string): string[] {
  return text
    .split(/[\s,;，；]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}
