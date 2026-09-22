// 「从链接导入」的地址归一与抓回内容的形状自检。
//
// 与 local-path.ts 对称：那边把一段**本地路径文本**变成可 fetch 的 file: URL，这边把一段
// **网络地址文本**变成可 fetch 的 http(s) URL。两层都只做「归一 + 说人话的原因」，取字节留在调用方。
// 纯函数、不碰任何 chrome API（工作台页与 node 单测都要能跑，同 zip-transfer 的取向）。
//
// 为什么地址要归一：用户手上拿到的是各种形态 —— GreasyFork 的 `/scripts/<id>/code/<name>.user.js`、
// GitHub 的 raw 链接、Gist 的 raw、某个静态托管上的 .user.js。这些本来就是合法 URL，
// 难的是**用户粘错东西**（网页地址、API 地址、本地文件），所以这里一半是校验、一半是纠错指引。
//
// 内容形状自检的判据刻意简单（文本特征，不看 content-type）：HTML 必带 `<html` / `<!doctype`，
// JSON 必是可解析的 { } / [ ]，其余长度的纯文本按脚本站。目的不是精确识别，
// 而是在「用户粘错地址」这个高频错误上给出人话，而不是把一段 HTML 当脚本装进去、让他在运行期困惑。

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
    return { ok: false, reason: '本地文件用「输入文件路径」或「粘贴脚本代码」导入，这里只收网络地址' }
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
