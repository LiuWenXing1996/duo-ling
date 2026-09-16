// status-bubble.ts 浮窗数据内核单测（提案②）：computeBubbleData 纯函数。
// chrome 侧依赖（project-store / store / element-picker-client）全部 mock——本文件只验证
// 「enabled + matches 命中 + 错误计数口径」的判定逻辑本身。
import { describe, expect, it, vi } from 'vitest'
import type { ScriptProject, UserScriptErrorRecord } from './types'

vi.mock('./project-store', () => ({ listProjects: vi.fn() }))
vi.mock('./store', () => ({ listUserScriptErrors: vi.fn() }))
vi.mock('@/lib/element-picker-client', () => ({ isUserScriptsApiAvailable: vi.fn(() => true) }))

const { computeBubbleData } = await import('./status-bubble')

function project(overrides: Partial<ScriptProject>): ScriptProject {
  return {
    v: 1,
    uuid: 'u1',
    name: '脚本A',
    enabled: true,
    config: {
      matches: ['*://example.com/*'],
      allFrames: true,
      runAt: 'document_end',
    },
    files: {},
    entry: 'main.js',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function err(overrides: Partial<UserScriptErrorRecord>): UserScriptErrorRecord {
  return {
    id: 'e1',
    uuid: 'u1',
    name: '脚本A',
    phase: 'runtime',
    message: 'boom',
    time: 1,
    ...overrides,
  }
}

const URL = 'https://example.com/page'

describe('computeBubbleData（本页脚本判定 + 错误计数）', () => {
  it('enabled + matches 命中 → 出现在浮窗；未启用 / 不命中 → 不出现', () => {
    const projects = [
      project({ uuid: 'u1', name: 'A' }),
      project({ uuid: 'u2', name: 'B', enabled: false }),
      project({ uuid: 'u3', name: 'C', config: { matches: ['*://other.com/*'], allFrames: true, runAt: 'document_end' } }),
    ]
    const d = computeBubbleData(URL, 'example.com', projects, [])
    expect(d).not.toBeNull()
    expect(d!.scripts.map((s) => s.name)).toEqual(['A'])
    expect(d!.host).toBe('example.com')
  })

  it('excludeMatches 命中时排除', () => {
    const projects = [
      project({
        config: { matches: ['*://example.com/*'], excludeMatches: ['*://example.com/admin*'], allFrames: true, runAt: 'document_end' },
      }),
    ]
    expect(computeBubbleData('https://example.com/admin/x', 'example.com', projects, [])).toBeNull()
    expect(computeBubbleData(URL, 'example.com', projects, [])).not.toBeNull()
  })

  it('错误计数口径 = runtime + register（bridge 不计），附最新一条摘要', () => {
    const errors = [
      err({ id: 'e1', phase: 'runtime', message: '最新', time: 4 }),
      err({ id: 'e2', phase: 'bridge', message: '噪音', time: 3 }),
      err({ id: 'e3', phase: 'register', message: '注册失败', time: 2 }),
      err({ id: 'e4', phase: 'runtime', message: '更早', time: 1 }),
    ]
    const d = computeBubbleData(URL, 'example.com', [project({})], errors)
    expect(d!.scripts[0]!.errorCount).toBe(3) // runtime ×2 + register ×1，bridge 不计
    expect(d!.scripts[0]!.lastError).toEqual({ message: '最新', time: 4 })
  })

  it('无命中脚本返回 null（= 不注入 / 应隐藏）', () => {
    expect(computeBubbleData(URL, 'example.com', [], [])).toBeNull()
    expect(computeBubbleData(URL, 'example.com', [project({ enabled: false })], [])).toBeNull()
  })
})
