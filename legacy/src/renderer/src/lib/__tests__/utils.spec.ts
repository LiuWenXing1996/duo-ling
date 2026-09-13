import { describe, expect, it } from 'vitest'
import { cn } from '../utils'

describe('cn', () => {
  it('合并多个类名', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('过滤假值类名', () => {
    expect(cn('base', false && 'hidden', undefined, 'active')).toBe('base active')
  })

  it('使用 tailwind-merge 解决类名冲突', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4')
  })
})
