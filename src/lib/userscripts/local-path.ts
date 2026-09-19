// 「从本地路径导入」的路径文本 → file:// URL 归一与校验。
// 纯函数、不碰任何 chrome API：offscreen 与 node 单测都要能跑（同 zip-transfer 的取向）。
//
// 为什么需要这一层：导入链路的入口只认「字节」，而本地路径取字节唯一可行的姿势是
// `fetch('file:///…')`（扩展页 fetch + 已声明的 `<all_urls>` 已覆盖 `file:///*`，
// 无需改 manifest —— 实测见 README「关键坑与规避」）。但用户手敲的是一段**路径文本**，
// fetch 要的是一个 **URL**，两者之间有四类坑，统一在这里收口：
//   · 裸路径不是合法 URL：`fetch('/a/b.zip')` 会被当**相对地址**解析到扩展页自身
//     （实测报 "Failed to fetch"），不转换永远读不到文件；
//   · `~` 展开不了：扩展里没有 HOME 概念，`~` 在浏览器眼里就是个叫「~」的目录名；
//   · `#` `?` 空格 在 URL 里有特殊含义：不逐段编码，`/a#b.zip` 的 `#b.zip` 会被当
//     fragment 丢掉，变成去读 `/a`；
//   · 相对路径没有基准目录可锚定：扩展里不存在 cwd。
//
// 输出刻意区分「报错原因」与「拿不到就报错」两类：能给出人话原因的一律给原因
// （用户手敲的输入，退回一句「路径非法」等于没说）。

/** 归一结果：成功给可直接 fetch 的 URL；失败给人话原因（直接展示给用户） */
export type LocalPathResult =
  | { ok: true; url: string; path: string }
  | { ok: false; reason: string }

/**
 * 本地路径文本 → `file:` URL。接受三种写法：
 *   · `/Users/me/duo.zip`（裸绝对路径，最常用）
 *   · `file:///Users/me/duo.zip` / `file:/Users/me/duo.zip`（从别处复制来的 URL 形态）
 *   · `file://localhost/Users/me/duo.zip`
 * 另兼容 Windows 盘符（`C:\x.zip` → `file:///C:/x.zip`），虽然本期只在 macOS 手测。
 */
export function toFileUrl(input: string): LocalPathResult {
  // 剥掉 URL 形态的前缀：file:// 与可选的 localhost 主机段一起剥，
  // 三者都落到「以 / 开头的路径」这一种形态（`file:///x` / `file:/x` / `file://localhost/x`）
  const p = input.trim().replace(/^file:(\/\/)?(localhost)?/i, '')

  if (!p) return { ok: false, reason: '请填写文件路径' }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    // http(s)/ws 等带主机名的形态：本期只做本地路径，不在这里顺手当 URL 下载
    return { ok: false, reason: '只支持本地文件路径；网络地址（http/https）暂不支持' }
  }
  if (p.startsWith('~')) {
    return { ok: false, reason: '~ 无法展开，请填绝对路径（以 / 开头）' }
  }

  // Windows 盘符：反斜杠归一成正斜杠（zip 内路径同规）；补前导 / 以免盘符被当成 URL 主机
  let path = p
  if (/^[a-zA-Z]:[\\/]/.test(path)) path = '/' + path.replace(/\\/g, '/')

  if (!path.startsWith('/')) {
    return { ok: false, reason: '请填绝对路径（以 / 开头）' }
  }
  if (!/\.zip$/i.test(path)) {
    return { ok: false, reason: '只支持 .zip 导入包' }
  }

  let url: URL
  try {
    url = new URL('file://' + encodePath(path))
  } catch {
    return { ok: false, reason: '路径里有无法转成 URL 的字符' }
  }
  if (url.protocol !== 'file:') return { ok: false, reason: '路径里有无法转成 URL 的字符' }
  return { ok: true, url: url.href, path }
}

/**
 * 逐段编码路径：只编码**段内**字符，保留 `/` 分隔符。两类段要原样留：
 *   · 首段 —— POSIX 绝对路径里它是空串（留前导 /）；
 *   · 盘符段 —— 补过前导 / 之后盘符落到 index 1，`C:` 的冒号编码成 `%3A` 就认不出来了。
 * 这是本模块唯一一处「不能整体 encodeURIComponent」的原因。
 */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((seg, i) => (i === 0 || /^[a-zA-Z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/')
}

/**
 * 读 zip 字节前的形状自检：`file:` URL 拿到的若不是 zip（比如填了个目录、或后缀骗人），
 * 交给解码层只会报「不是合法 zip」这种离现场很远的错，故在入口先按魔数拦一道。
 * ZIP 的本地文件头魔数 `PK\x03\x04`（空 zip 是 `PK\x05\x06`，同样放行）。
 *
 * 只回答「是不是」：曾把实际字节的前 4 字节十六进制也拼进报错（便于判断读错了什么），
 * 2026-09-19 老大拍板改成一句人话（「未识别到正确的 zip 内容，疑似 zip 内容被损坏」），
 * 诊断数据不进用户文案，故不再需要导出十六进制头的工具。
 */
export function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false
  return (bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06)
}
