// 「从本地路径导入」的路径文本 → file:// URL 归一与校验
// （纯函数、不碰任何 chrome API：offscreen 与 node 单测都要能跑）。
// 四类坑与报错口径见 docs/adr/0040-local-path-import-normalization.md；与 script-url.ts 对称。

/** 归一结果：成功给可直接 fetch 的 URL；失败给人话原因（直接展示给用户） */
export type LocalPathResult =
  { ok: true; url: string; path: string } | { ok: false; reason: string }

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
    // 带主机名的形态（http/https/ws…）：本入口只管本地路径。网上的**脚本源码**有自己的入口
    // （「从链接导入」），zip 包仍得先落到本地 —— 不在这里顺手当 http 下载，
    // 否则同一个入口的产物一半是脚本、一半是 zip，后面每条上报文案都要分叉。
    return {
      ok: false,
      reason: '只支持本地文件路径（.zip）；网上的脚本用「从链接导入」，zip 包需先下载到本地',
    }
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
 * 只回答「是不是」：诊断数据（前 4 字节十六进制这类）不进用户文案，报错只用一句人话
 * （「未识别到正确的 zip 内容，疑似 zip 内容被损坏」）。
 */
export function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false
  return (bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06)
}
