// 通用格式化工具函数：纯函数，便于单测。

/** Unix 秒的时间戳（如 isomorphic-git 的 author.timestamp）格式化为 YYYY-MM-DD HH:mm */
export function formatTimestamp(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
