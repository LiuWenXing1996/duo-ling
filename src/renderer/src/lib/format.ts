// 通用格式化工具函数：纯函数，便于单测。

/** 日期格式化为 YYYY-MM-DD（用于会话历史标题的展示日期） */
export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Unix 秒的时间戳（如 isomorphic-git 的 author.timestamp）格式化为 YYYY-MM-DD HH:mm */
export function formatTimestamp(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 截断长文本，用于在变更卡片里展示 patch 的查找串摘要 */
export function truncate(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max)}` : text
}
