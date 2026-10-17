import { describe, expect, it } from 'vitest'
import { formatMessageTime, formatTimestamp, formatTokens } from './format'

describe('formatTokens', () => {
  it('空值与零返回空串', () => {
    expect(formatTokens(undefined)).toBe('')
    expect(formatTokens(0)).toBe('')
  })

  it('千位以下原值', () => {
    expect(formatTokens(1)).toBe('1')
    expect(formatTokens(999)).toBe('999')
  })

  it('千位级一位小数', () => {
    expect(formatTokens(1200)).toBe('1.2k')
    expect(formatTokens(9999)).toBe('10.0k')
  })

  it('万位级取整', () => {
    expect(formatTokens(10000)).toBe('10k')
    expect(formatTokens(12345)).toBe('12k')
    expect(formatTokens(999499)).toBe('999k')
  })

  it('百万级换 M，四舍五入进位时同样落 M 档', () => {
    expect(formatTokens(1e6)).toBe('1M')
    expect(formatTokens(1.2e6)).toBe('1.2M')
    expect(formatTokens(1e7)).toBe('10M')
    // 999,999 千位四舍五入进位到 1000k，落 M 档而非「1000k」
    expect(formatTokens(1e6 - 1)).toBe('1M')
  })
})

describe('formatTimestamp', () => {
  it('零值返回空串', () => {
    expect(formatTimestamp(0)).toBe('')
  })

  it('Unix 秒格式化为 YYYY-MM-DD HH:mm', () => {
    // 固定时区下核对格式；本地时区只影响数值不影响形状
    expect(formatTimestamp(1700000000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

describe('formatMessageTime', () => {
  it('ISO 时间格式化为 MM-DD HH:mm（本地时区只影响数值不影响形状）', () => {
    expect(formatMessageTime('2026-09-19T04:08:44.000Z')).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('解析不了就返回空串，不画 Invalid Date', () => {
    expect(formatMessageTime('')).toBe('')
    expect(formatMessageTime('不是时间')).toBe('')
  })
})
