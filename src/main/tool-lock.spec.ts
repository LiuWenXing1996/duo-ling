import { describe, expect, it } from 'vitest'
import { getToolLockStatus } from './tool-lock'

describe('tool-lock（只读锁注册表，Phase 1 恒未锁）', () => {
  it('任何工具恒返回「未被持有」，且形状一致（toolId/locked/holderId）', () => {
    const a = getToolLockStatus('tool-a')
    expect(a.locked).toBe(false)
    expect(a.toolId).toBe('tool-a')
    expect(a.holderId).toBeUndefined()
    expect(getToolLockStatus('tool-b')).toMatchObject({ toolId: 'tool-b', locked: false })
  })
})
