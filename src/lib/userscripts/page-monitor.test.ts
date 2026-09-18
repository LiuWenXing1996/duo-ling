// page-monitor.ts 单测：登记表行为 + 快照错误过滤纯函数。
// 不 mock chrome：noteRunStart / resetPageRuns 在无端口（monitorPorts 空）时推送为 no-op，
// 登记表是纯内存 Map，可直接断言；listUserScriptErrors 只在 snapshotFor 调用，本文件不触达。
import { describe, expect, it } from 'vitest'
import type { UserScriptErrorRecord } from './types'
import {
  forgetPageTab,
  noteRunStart,
  pageRunsByTab,
  pickErrorsForRuns,
  resetPageRuns,
} from './page-monitor'

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

describe('运行登记表（noteRunStart / resetPageRuns / forgetPageTab）', () => {
  it('登记一次运行；同 uuid 重复广播覆盖为最新 runId', () => {
    const tab = 101
    pageRunsByTab.delete(tab)
    noteRunStart(tab, 'u1', 'r1')
    noteRunStart(tab, 'u2', 'r2')
    expect(pageRunsByTab.get(tab)!.get('u1')).toMatchObject({ uuid: 'u1', runId: 'r1' })
    noteRunStart(tab, 'u1', 'r1b')
    expect(pageRunsByTab.get(tab)!.get('u1')!.runId).toBe('r1b')
    expect(pageRunsByTab.get(tab)!.size).toBe(2)
    pageRunsByTab.delete(tab)
  })

  it('新文档导航（resetPageRuns）清空该 tab；tab 关闭（forgetPageTab）同样清空；不影响其它 tab', () => {
    pageRunsByTab.delete(201)
    pageRunsByTab.delete(202)
    noteRunStart(201, 'u1', 'r1')
    noteRunStart(202, 'u2', 'r2')
    resetPageRuns(201)
    expect(pageRunsByTab.has(201)).toBe(false)
    expect(pageRunsByTab.get(202)!.get('u2')).toBeDefined()
    forgetPageTab(202)
    expect(pageRunsByTab.has(202)).toBe(false)
    // 重复 reset（无记录）不炸也不推送
    expect(() => resetPageRuns(201)).not.toThrow()
  })
})

describe('pickErrorsForRuns（快照错误过滤）', () => {
  const runs = [
    { uuid: 'u1', runId: 'r1', startedAt: 1 },
    { uuid: 'u2', runId: 'r2', startedAt: 2 },
  ]

  it('只保留 runId 命中当前运行集的 runtime 错误（register 无 runId、他人 runId 全排除）', () => {
    const errors = [
      err({ id: 'e1', uuid: 'u1', runId: 'r2', message: '命中 r2' }),
      err({ id: 'e2', uuid: 'u1', runId: null, phase: 'register' }), // 无运行上下文
      err({ id: 'e3', uuid: 'u3', runId: 'rX' }), // 他人运行
    ]
    const picked = pickErrorsForRuns(errors, runs)
    expect(picked).toHaveLength(1)
    expect(picked[0]).toMatchObject({ uuid: 'u1', runId: 'r2', message: '命中 r2' })
  })

  it('message 截断到展示上限', () => {
    const long = 'x'.repeat(500)
    const picked = pickErrorsForRuns([err({ runId: 'r1', message: long })], runs)
    expect(picked[0]!.message.length).toBeLessThanOrEqual(200)
  })

  it('无运行集 → 恒为空（SW 重启丢失登记的窗口期，面板不显示旧错误）', () => {
    expect(pickErrorsForRuns([err({ runId: 'r1' })], [])).toEqual([])
  })
})
