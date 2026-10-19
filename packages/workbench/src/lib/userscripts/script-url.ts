// 「从链接导入」的地址归一与抓回内容的形状自检（纯函数，与 local-path.ts 对称）。
// 为什么归一、形状自检判据见 docs/adr/0041-link-import-normalization.md。

/** 抓回内容的字符数上限：脚本源码再长也到不了这个量级，超了必是拿错了东西 */
const MAX_TEXT_CHARS = 1_500_000

/** 地址归一结果：成功给可直接 fetch 的 URL；失败给人话原因（直接展示给用户） */
export type ScriptUrlResult = { ok: true; url: string } | { ok: false; reason: string }

/**
 * 用户输入的脚本文本地址 → 可 fetch 的 http(s) URL。
 *
 * 只收 http / https：本地文件走「输入文件路径」（且那条只认 zip 包），
 * `data:` / `blob:` / `javascript:` 之类一律拒绝 —— 它们的来源无从交代。
 */
export function toScriptUrl(input: string): ScriptUrlResult {
  const raw = input.trim()
  if (!raw) return { ok: false, reason: '请填写脚本地址' }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // 少了 scheme 是最常见的输入形态（`example.com/x.user.js`），给一句能自纠的话
    return { ok: false, reason: '地址要以 http:// 或 https:// 开头' }
  }

  if (url.protocol === 'http:' || url.protocol === 'https:') return { ok: true, url: url.href }
  if (url.protocol === 'file:') {
    return {
      ok: false,
      reason: '本地文件用「输入文件路径」或「粘贴脚本代码」导入，这里只收网络地址',
    }
  }
  return { ok: false, reason: `只支持 http / https 地址（收到的是 ${url.protocol}）` }
}

/**
 * 抓回的文本像不像一份脚本源码；不像时给出人话原因（直接展示给用户）。
 *
 * 顺序有讲究：**先判空、再判长度、最后判形态** —— 空内容与超大内容都不该走到形态判断里去
 * （前者会因「不像 HTML」被误判成脚本，后者解析成本高且毫无意义）。
 */
export function inspectFetchedText(text: string): { ok: true } | { ok: false; reason: string } {
  if (!text.trim()) return { ok: false, reason: '这个地址没有返回内容' }
  if (text.length > MAX_TEXT_CHARS) {
    return { ok: false, reason: '这个地址返回的内容过大，不像是脚本源码' }
  }

  const head = text.trimStart().toLowerCase()
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    return { ok: false, reason: '这个地址返回的是网页，不是脚本源码；请改用 raw / 直链地址' }
  }

  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed)
      return { ok: false, reason: '这个地址返回的是数据文件，不是脚本源码' }
    } catch {
      // 以 { 开头但不是合法 JSON（比如被包装成对象的脚本）—— 照常按脚本站放行
    }
  }

  return { ok: true }
}
