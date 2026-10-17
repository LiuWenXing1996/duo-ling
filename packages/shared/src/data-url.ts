// data URL 的拆与拼（纯字符串函数，零依赖）：上传侧拆出 (mime, base64)，回读侧拼回一串。
//
// 两侧落在不同语境：拆在 offscreen 的资源上传入口（offscreen-document 的 fs/assets），
// 拼在界面面板的 <img src> / 预览 / 下载。放同一处，「互为逆」这件事才只有一份定义。

/** 拆 data URL 的 `data:<mime>;base64,<正文>`：上传时服务端要把 mime 与 base64 分开 */
export function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } {
  const comma = dataUrl.indexOf(',')
  const header = comma >= 0 ? dataUrl.slice(5, comma) : ''
  return {
    mediaType: header.split(';')[0] || 'application/octet-stream',
    base64: comma >= 0 ? dataUrl.slice(comma + 1) : '',
  }
}

/** 读回的资源拼回 data URL（与 parseDataUrl 互为逆）；只认它要用的两个字段 */
export function dataUrlOf(asset: { mediaType: string; base64: string }): string {
  return `data:${asset.mediaType};base64,${asset.base64}`
}
