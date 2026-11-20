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
