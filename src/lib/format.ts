// 通用格式化工具函数：纯函数，便于单测。

/** Unix 秒的时间戳（如 isomorphic-git 的 author.timestamp）格式化为 YYYY-MM-DD HH:mm */
export function formatTimestamp(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** ISO 时间格式化为 MM-DD HH:mm（消息气泡下方的时间）。带月份日期而不只到分钟：
 *  一条会话可能跨天，只有 HH:mm 时「昨天下午三点」和「今天下午三点」长得一样。
 *  解析不了（空串 / 旧记录缺时间）返回空串 —— 调用方据此不渲染，而不是画一个 Invalid Date。 */
export function formatMessageTime(iso: string): string {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** token 量按量级缩写：千位以下原值；千位级一位小数（1.2k）；万位级取整（12k）；百万级换 M（1.2M / 12M） */
export function formatTokens(n?: number): string {
  if (!n) return ''
  if (n >= 1e6) {
    const m = n / 1e6
    return `${m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')}M`
  }
  const k = Math.round(n / 1000)
  if (k >= 1000) return '1M' // 999,999 这类千位进位值落 M 档，避免输出 1000k
  if (n >= 10000) return `${k}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
