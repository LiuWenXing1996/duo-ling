// status-bubble.ts 浮窗数据内核单测：computeBubbleData 纯函数。
// chrome 侧依赖（project-store / store）全部 mock——本文件只验证
// 「enabled + matches 命中」的判定与「错误原样透传（含 runId / phase）」两件事。
//
// 注意：**「本次运行」的过滤不在这里**——runId 指针归浮窗（src/public/duoling-status.js），
// SW 只透传原始错误记录，故此处断言的是透传而非过滤。
import { describe, expect, it, vi } from 'vitest'
import type { ScriptProject, UserScriptErrorRecord } from './types'

vi.mock('./project-store', () => ({ listProjects: vi.fn() }))
vi.mock('./store', () => ({ listUserScriptErrors: vi.fn() }))

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
    runId: null,
    ...overrides,
  }
}

const URL = 'https://example.com/page'

describe('computeBubbleData（本页脚本判定 + 错误透传）', () => {
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

  it('错误口径 = runtime + register（bridge 不计），原样带 runId / phase，顺序保持（最新在前）', () => {
    const errors = [
      err({ id: 'e1', phase: 'runtime', message: '最新', time: 4, runId: 'r2' }),
      err({ id: 'e2', phase: 'bridge', message: '噪音', time: 3 }),
      err({ id: 'e3', phase: 'register', message: '注册失败', time: 2 }),
      err({ id: 'e4', phase: 'runtime', message: '更早', time: 1, runId: 'r1' }),
    ]
    const d = computeBubbleData(URL, 'example.com', [project({})], errors)
    expect(d!.scripts[0]!.errors).toEqual([
      { message: '最新', time: 4, runId: 'r2', phase: 'runtime' },
      { message: '注册失败', time: 2, runId: null, phase: 'register' },
      { message: '更早', time: 1, runId: 'r1', phase: 'runtime' },
    ])
  })

  it('runId 缺省（旧记录）归一为 null；message 截断到 120 字符', () => {
    const long = 'x'.repeat(300)
    const d = computeBubbleData(URL, 'example.com', [project({})], [
      err({ id: 'e1', message: long, runId: undefined }),
    ])
    const item = d!.scripts[0]!.errors[0]!
    expect(item.runId).toBeNull()
    expect(item.phase).toBe('runtime')
    expect(item.message.length).toBe(120)
  })

  it('无命中脚本返回 null（= 浮窗自隐藏）', () => {
    expect(computeBubbleData(URL, 'example.com', [], [])).toBeNull()
    expect(computeBubbleData(URL, 'example.com', [project({ enabled: false })], [])).toBeNull()
  })
})
