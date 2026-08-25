import { describe, expect, it } from 'vitest'
import { formatDate, formatTimestamp, truncate } from './format'

describe('formatDate（Date 转 YYYY-MM-DD）', () => {
  it('补零输出', () => {
    expect(formatDate(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(formatDate(new Date(2026, 11, 25))).toBe('2026-12-25')
  })
})

describe('formatTimestamp（Unix 秒转 YYYY-MM-DD HH:mm）', () => {
  it('空值返回空串', () => {
    expect(formatTimestamp(0)).toBe('')
  })

  it('格式化时间戳（本地时区）', () => {
    // 用给定时间构造 Unix 秒并验证往返
    const d = new Date(2026, 0, 5, 9, 30)
    expect(formatTimestamp(d.getTime() / 1000)).toBe('2026-01-05 09:30')
  })
})

describe('truncate（截断长文本）', () => {
  it('超过 max 截断', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcde')
  })

  it('未超过 max 原样返回', () => {
    expect(truncate('abc', 5)).toBe('abc')
  })
})
